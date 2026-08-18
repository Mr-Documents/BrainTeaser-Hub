'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Colour-contrast regression guard.
 *
 * Reads the real token values out of _tokens.scss and checks every text-on-colour pairing the
 * UI actually renders, in both themes, against WCAG AA (4.5:1 - badges and button labels are
 * small text, so the relaxed 3:1 large-text threshold does not apply).
 *
 * This exists because a primary button once shipped with indigo text on an indigo gradient:
 * `:root[data-theme] a` (specificity 0-2-1) was outranking `.btn` (0-1-0). Palette edits are
 * cheap to make and easy to get wrong by eye - this makes the failure loud instead.
 */

const TOKENS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'scss', '_tokens.scss'), 'utf8');

// ------------------------------------------------------------------ colour maths

const toRgb = (hex) => {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const channelLuminance = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex) => {
  const [r, g, b] = toRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2.1 contrast ratio, 1 to 21. */
function contrastRatio(a, b) {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Composite a translucent colour over an opaque backdrop - what `color-mix(… n%, transparent)` renders as. */
function blend(foreground, alpha, backdrop) {
  const f = toRgb(foreground);
  const b = toRgb(backdrop);
  const channels = [0, 1, 2].map((i) => Math.round(f[i] * alpha + b[i] * (1 - alpha)));
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The midpoint of a two-stop gradient - its least-contrasty region against white. */
function midpoint(a, b) {
  const [x, y] = [toRgb(a), toRgb(b)];
  const channels = [0, 1, 2].map((i) => Math.round((x[i] + y[i]) / 2));
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------- reading the real tokens

/** Pull a `--name: #value;` declaration out of a specific block of the token file. */
function readToken(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(match, `token --${name} not found (renamed or removed?)`);
  return match[1];
}

function blockFor(theme) {
  // The dark palette is the bare :root block; light overrides it under [data-theme='light'].
  const lightStart = TOKENS.indexOf("[data-theme='light']");
  assert.ok(lightStart > 0, "could not locate the [data-theme='light'] block");
  return theme === 'light' ? TOKENS.slice(lightStart) : TOKENS.slice(0, lightStart);
}

const HUES = ['indigo', 'emerald', 'amber', 'pink', 'sky', 'violet', 'red'];
const AA = 4.5;

function paletteFor(theme) {
  const own = blockFor(theme);
  const dark = blockFor('dark');
  // Light only redefines what it changes, so anything absent falls back to the dark block.
  const token = (name) => (new RegExp(`--${name}:`).test(own) ? readToken(own, name) : readToken(dark, name));

  return {
    bg: token('bg'),
    surface: token('surface'),
    surfaceRaised: token('surface-raised'),
    ink: token('ink'),
    hues: Object.fromEntries(HUES.map((h) => [h, readToken(dark, h)])),
    inks: Object.fromEntries(HUES.map((h) => [h, token(`${h}-ink`)])),
  };
}

const assertReadable = (label, foreground, background) => {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= AA,
    `${label}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below the ${AA}:1 minimum`
  );
};

// --------------------------------------------------------------------- the tests

test('the contrast helper agrees with known WCAG reference values', () => {
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
  assert.equal(Math.round(contrastRatio('#ffffff', '#ffffff')), 1);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#777777') - 4.48) < 0.05);
});

for (const theme of ['dark', 'light']) {
  test.describe(`${theme} theme`, () => {
    const palette = paletteFor(theme);

    test('primary button label is readable across the whole gradient', () => {
      const gradient = blockFor('dark').match(/--accent-gradient:[^;]*?(#[0-9a-fA-F]{6})[^;]*?(#[0-9a-fA-F]{6})/);
      assert.ok(gradient, '--accent-gradient must declare two hex stops');
      const [, start, end] = gradient;

      for (const [name, stop] of [
        ['start', start],
        ['midpoint', midpoint(start, end)],
        ['end', end],
      ]) {
        assertReadable(`primary button (${name})`, '#ffffff', stop);
      }
    });

    test('ghost and secondary button labels are readable', () => {
      assertReadable('ghost button on page background', palette.ink, palette.bg);
      assertReadable('ghost button on a panel', palette.ink, palette.surface);
      assertReadable('secondary button', palette.ink, palette.surfaceRaised);
    });

    test('every badge is readable on its own tint', () => {
      for (const hue of HUES) {
        // .badge--x renders as a 16% tint of the hue over the panel surface.
        assertReadable(`badge ${hue}`, palette.inks[hue], blend(palette.hues[hue], 0.16, palette.surface));
      }
    });

    test('body and muted text are readable on every surface', () => {
      const muted = new RegExp('--ink-muted:').test(blockFor(theme))
        ? readToken(blockFor(theme), 'ink-muted')
        : readToken(blockFor('dark'), 'ink-muted');

      for (const surface of [palette.bg, palette.surface, palette.surfaceRaised]) {
        assertReadable('body text', palette.ink, surface);
        assertReadable('muted text', muted, surface);
      }
    });
  });
}

test('generic anchor colour rules cannot outrank component classes', () => {
  const base = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'scss', '_base.scss'), 'utf8');
  const themedAnchorRules = base.match(/^\s*[^\s/].*data-theme.*\ba\b.*\{/gm) || [];

  for (const rule of themedAnchorRules) {
    assert.match(
      rule,
      /:where\(/,
      `"${rule.trim()}" must be wrapped in :where() - a themed element selector outranks .btn and repaints button labels`
    );
  }
});
