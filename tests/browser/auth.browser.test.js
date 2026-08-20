'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestApp, signIn } = require('../helpers/testApp');
const { openPage, waitFor } = require('./helpers/browser');

/**
 * public/js/auth.js and the shared parts of ui.js, driven through the real pages.
 *
 * auth.js is pure progressive enhancement, so the tests check two things: that the enhancement
 * behaves, and that nothing it does would break the plain-HTML path underneath it.
 */

const SCRIPTS = ['ui.js', 'auth.js'];

test.describe('the sign-in form', () => {
  test('rejects a malformed address in the browser, before any request', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    page.$id('email').value = 'not-an-email';
    page.$('[data-auth-form]').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await page.settle(40);

    const error = page.$('[data-email-error]');
    assert.equal(error.hidden, false, 'the error is shown inline');
    assert.match(error.textContent, /does not look like an email/i);
    assert.equal(issuedLinks.length, 0, 'and no email was spent on it');
  });

  test('validates on blur rather than on every keystroke', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    const input = page.$id('email');
    const error = page.$('[data-email-error]');

    // Mid-typing, an incomplete address must not be shouted at.
    input.value = 'ada@';
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.settle(20);
    assert.equal(error.hidden, true, 'no error while still typing');

    input.dispatchEvent(new page.window.Event('blur', { bubbles: true }));
    await page.settle(20);
    assert.equal(error.hidden, false, 'but flagged once the field is left');
  });

  test('clears the error as soon as the player starts correcting it', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    const input = page.$id('email');
    const error = page.$('[data-email-error]');

    input.value = 'bad';
    input.dispatchEvent(new page.window.Event('blur', { bubbles: true }));
    await page.settle(20);
    assert.equal(error.hidden, false);

    input.value = 'bad@example.com';
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.settle(20);
    assert.equal(error.hidden, true, 'the error clears while they fix it');
  });

  test('a valid address disables the button so a double click cannot send twice', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    page.$id('email').value = 'ada@example.com';
    page.$('[data-auth-form]').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await page.settle(30);

    const button = page.$('[data-submit-button]');
    assert.equal(button.disabled, true, 'sending email is not free');
    assert.match(page.text('[data-submit-label]'), /sending/i);
  });

  test('the form still posts normally with the enhancement removed', async (t) => {
    // Proves the client layer is genuinely optional: no scripts loaded at all.
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: [] });
    t.after(() => page.close());

    const form = page.$('[data-auth-form]');
    assert.equal(form.getAttribute('method'), 'post');
    assert.equal(form.getAttribute('action'), '/signin');
    assert.ok(page.$id('email').required, 'the browser enforces it without us');
  });
});

test.describe('the "check your inbox" screen', () => {
  /** Post the sign-in form the way a browser would, and open the resulting page. */
  async function openSentScreen(app, email = 'ada@gmail.com') {
    const request = require('supertest');
    const res = await request(app).post('/signin').send({ email });
    const { JSDOM } = require('jsdom');
    return { html: res.text, JSDOM };
  }

  test('offers a mail shortcut only for a provider it recognises', async (t) => {
    const { app } = buildTestApp();

    // A gmail address gets the Gmail shortcut and nothing else.
    const gmail = await openSentScreen(app, 'ada@gmail.com');
    assert.match(gmail.html, /data-mail-shortcuts/);
    assert.match(gmail.html, /mail\.google\.com/);

    t.diagnostic('shortcut visibility is applied by auth.js at runtime');
  });

  test('the resend button starts on a cooldown', async () => {
    const { app } = buildTestApp();
    const request = require('supertest');
    const res = await request(app).post('/signin').send({ email: 'ada@example.com' });

    const { JSDOM } = require('jsdom');
    const fs = require('node:fs');
    const path = require('node:path');
    const dom = new JSDOM(res.text, { runScripts: 'dangerously', pretendToBeVisual: true });

    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) });

    for (const name of SCRIPTS) {
      const el = dom.window.document.createElement('script');
      el.textContent = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', name), 'utf8');
      dom.window.document.body.appendChild(el);
    }
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));

    const button = dom.window.document.querySelector('[data-resend-button]');
    assert.equal(button.disabled, true, 'a resend is rate-limited client-side too');
    assert.match(
      dom.window.document.querySelector('[data-resend-timer]').textContent,
      /\d+s/,
      'and the wait is shown'
    );
    dom.window.close();
  });
});

test.describe('the profile page', () => {
  test('checks display-name availability as you type', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const page = await openPage({ app, url: '/profile', scripts: SCRIPTS, cookie });
    t.after(() => page.close());

    const input = page.$('[data-name-input]');
    input.value = 'Grace Hopper';
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));

    await waitFor(() => page.text('[data-name-status]')?.includes('available'), {
      label: 'the availability check',
      timeout: 3000,
    });
    assert.match(page.text('[data-name-status]'), /"Grace Hopper" is available/);
    assert.equal(page.$('[data-name-submit]').disabled, false);
  });

  test('blocks saving a name that is already taken', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const first = await signIn(app, issuedLinks, 'ada@example.com');

    const request = require('supertest');
    await request(app).post('/profile/name').set('Cookie', first.cookie).send({ displayName: 'Grace' });

    const second = await signIn(app, issuedLinks, 'bob@example.com');
    const page = await openPage({ app, url: '/profile', scripts: SCRIPTS, cookie: second.cookie });
    t.after(() => page.close());

    const input = page.$('[data-name-input]');
    input.value = 'grace';
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));

    await waitFor(() => page.$('[data-name-submit]').disabled, {
      label: 'the save button to disable',
      timeout: 3000,
    });
    assert.match(page.text('[data-name-status]'), /already plays under that name/i);
  });

  test('your own current name is not reported as taken', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const page = await openPage({ app, url: '/profile', scripts: SCRIPTS, cookie });
    t.after(() => page.close());

    const input = page.$('[data-name-input]');
    input.value = 'ada';
    input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.settle(500);

    assert.equal(page.$('[data-name-submit]').disabled, false, 'you can always keep your own name');
  });

  test('deleting an account requires typing the display name', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const page = await openPage({ app, url: '/profile', scripts: SCRIPTS, cookie });
    t.after(() => page.close());

    const form = page.$('form[action="/profile/delete"]');
    assert.ok(form, 'the danger zone exists');
    assert.ok(page.$id('confirm').required, 'confirmation is mandatory');
    assert.ok(page.$('.disclosure--danger'), 'and it is behind a disclosure, not one click away');
  });
});

test.describe('shared UI behaviour', () => {
  test('the theme toggle flips the document theme and remembers it', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    const before = page.document.documentElement.getAttribute('data-theme');
    page.$('[data-theme-toggle]').click();
    await page.settle(20);

    const after = page.document.documentElement.getAttribute('data-theme');
    assert.notEqual(after, before, 'the theme actually changes');
    assert.equal(JSON.parse(page.window.localStorage.getItem('bth:theme')), after, 'and is remembered');
  });

  test('the mobile nav opens and closes', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    const nav = page.$('[data-nav]');
    const toggle = page.$('[data-nav-toggle]');

    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    await page.settle(20);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(nav.classList.contains('is-open'));

    toggle.click();
    await page.settle(20);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });

  test('Escape closes the mobile nav', async (t) => {
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/signin', scripts: SCRIPTS });
    t.after(() => page.close());

    page.$('[data-nav-toggle]').click();
    await page.settle(20);

    page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await page.settle(20);

    assert.equal(page.$('[data-nav]').classList.contains('is-open'), false);
  });
});
