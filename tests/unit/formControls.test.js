'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Form-control styling guard.
 *
 * This exists because the sign-in page shipped with `<input type="email">` while the stylesheet
 * only named text/search/number/password. The field matched no rule at all and rendered with raw
 * browser padding. An allow-list of input types is silently wrong the moment somebody adds a type
 * to a template, so the rule is written as an opt-out - and these tests hold it that way.
 */

const ROOT = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'main.css'), 'utf8');
const VIEWS_DIR = path.join(ROOT, 'views');

/** Input types that genuinely must not get text-field styling. */
const UNSTYLED_BY_DESIGN = new Set(['checkbox', 'radio', 'file', 'range', 'hidden', 'submit', 'button']);

function readViews(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return readViews(full);
    return entry.name.endsWith('.ejs')
      ? [{ name: path.relative(VIEWS_DIR, full), html: fs.readFileSync(full, 'utf8') }]
      : [];
  });
}

/** Every input type actually used across the templates. */
function inputTypesInViews() {
  const found = new Map();
  for (const view of readViews(VIEWS_DIR)) {
    for (const match of view.html.matchAll(/<input\b[^>]*\btype="([a-z-]+)"/g)) {
      if (!found.has(match[1])) found.set(match[1], view.name);
    }
  }
  return found;
}

/** The compiled rule that gives a control its box: padding, border, background. */
function formControlSelector() {
  const match = CSS.match(/([^{}]*?)\{width:100%;min-width:0;min-height:var\(--control-h\)/);
  assert.ok(match, 'could not find the shared form-control rule in the compiled CSS');
  return match[1];
}

test('the form-control rule is written as an opt-out, not an allow-list', () => {
  const selector = formControlSelector();

  assert.match(selector, /input:not\(/, 'inputs must be styled by exclusion so a new type is covered by default');
  assert.doesNotMatch(
    selector,
    /input\[type=(text|email|password|search|number)\]/,
    'naming individual text-like types is what caused type=email to ship unstyled'
  );
});

test('every input type used in a template receives control styling', () => {
  const selector = formControlSelector();
  const excluded = new Set([...selector.matchAll(/:not\(\[type=([a-z-]+)\]\)/g)].map((m) => m[1]));
  const used = inputTypesInViews();

  assert.ok(used.size > 0, 'expected to find inputs in the templates');

  for (const [type, view] of used) {
    if (UNSTYLED_BY_DESIGN.has(type)) continue;
    assert.equal(
      excluded.has(type),
      false,
      `<input type="${type}"> in ${view} is excluded from control styling and would render with raw browser padding`
    );
  }
});

test('the exclusion list only ever excludes controls that are not text fields', () => {
  const excluded = [...formControlSelector().matchAll(/:not\(\[type=([a-z-]+)\]\)/g)].map((m) => m[1]);

  for (const type of excluded) {
    assert.ok(
      UNSTYLED_BY_DESIGN.has(type),
      `"${type}" is excluded from control styling, but it is a text-like field that needs it`
    );
  }
});

test('controls share one size scale, so an input and a button line up on a row', () => {
  for (const token of ['--control-h', '--control-px', '--control-py']) {
    assert.match(CSS, new RegExp(`${token}:`), `${token} must be declared as a token`);
  }
  const selector = formControlSelector();
  assert.match(
    CSS,
    new RegExp(`${escapeRegex(selector)}\\{[^}]*padding:var\\(--control-py\\) var\\(--control-px\\)`)
  );
});

test('placeholders are legible rather than left to the browser', () => {
  assert.match(
    CSS,
    /::placeholder\{color:var\(--ink-faint\);opacity:1\}/,
    'Firefox dims placeholders unless opacity is reset'
  );
});

test('autofilled fields keep the site palette', () => {
  // Chrome paints autofill a hard yellow-white that ignores the theme entirely.
  assert.match(CSS, /:-webkit-autofill/);
  assert.match(CSS, /-webkit-text-fill-color:var\(--ink\)/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
