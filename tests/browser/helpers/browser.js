'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const request = require('supertest');

/**
 * A browser harness for the client-side scripts.
 *
 * The point is fidelity: these tests load the *real* HTML the server renders, execute the *real*
 * files from public/js, and route every `fetch` back into the *real* Express app. Nothing is
 * stubbed except the handful of browser APIs jsdom does not implement.
 *
 * So a broken selector, a renamed id, a null dereference or a client/server contract mismatch
 * fails here - none of which any of the API-level tests can see.
 */

const PUBLIC_JS = path.join(__dirname, '..', '..', '..', 'public', 'js');

const readScript = (name) => fs.readFileSync(path.join(PUBLIC_JS, name), 'utf8');

/** Fetch a page from the app exactly as a browser would, carrying cookies. */
async function renderPage(app, url, { cookie } = {}) {
  const req = request(app).get(url);
  if (cookie) req.set('Cookie', cookie);
  const res = await req;
  return { html: res.text, status: res.status, headers: res.headers };
}

/**
 * A `fetch` that dispatches into the Express app instead of the network.
 *
 * Returns a genuine Response-shaped object, because ui.js's api() inspects `response.ok`,
 * `response.status` and calls `response.json()` - if any of those were faked loosely the tests
 * would pass while the real client broke.
 */
function createAppFetch(app, jar) {
  return async function appFetch(url, options = {}) {
    const method = (options.method || 'GET').toLowerCase();
    const target = String(url).replace(/^https?:\/\/[^/]+/, '');

    let req = request(app)[method](target);

    for (const [key, value] of Object.entries(options.headers || {})) {
      req = req.set(key, value);
    }
    if (jar.cookie) req = req.set('Cookie', jar.cookie);
    if (options.body) req = req.send(JSON.parse(options.body));

    const res = await req;

    // Keep the jar current so a session issued mid-test is used by later calls.
    const setCookie = res.headers['set-cookie'];
    if (setCookie) jar.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: (name) => res.headers[String(name).toLowerCase()] },
      json: async () => res.body,
      text: async () => res.text,
    };
  };
}

/** Browser APIs jsdom does not provide, kept deliberately thin and honest. */
function installMissingBrowserApis(window, { clipboard }) {
  // jsdom has no matchMedia; ui.js uses it for the theme and the nav breakpoint.
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });

  // Recorded rather than no-oped, so a test can assert what the share button copied.
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        clipboard.push(text);
      },
    },
  });

  // jsdom implements neither; the share button falls back to clipboard when share is absent.
  window.navigator.share = undefined;
  window.document.execCommand = () => true;

  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0);
  }
}

/**
 * Boot a page in jsdom with its client scripts running.
 *
 * @param {object} options
 * @param {import('express').Express} options.app
 * @param {string} options.url page to load
 * @param {string[]} options.scripts filenames from public/js, in load order
 * @param {string} [options.cookie] session cookie to start with
 */
async function openPage({ app, url, scripts, cookie = '' }) {
  const { html, status } = await renderPage(app, url, { cookie });
  if (status >= 400) throw new Error(`${url} returned ${status}, cannot open it as a page`);

  const jar = { cookie };
  const clipboard = [];
  const consoleErrors = [];

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000' + url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.fetch = createAppFetch(app, jar);
  installMissingBrowserApis(window, { clipboard });

  // Surface script errors instead of letting them vanish - a thrown handler would otherwise
  // just look like "the button did nothing".
  window.addEventListener('error', (event) => consoleErrors.push(event.error || event.message));

  // Wait for jsdom to finish parsing before injecting anything. The page loads its scripts with
  // `defer`, so this is also what a real browser does - and injecting while readyState is still
  // 'loading' means a synthetic DOMContentLoaded lands before the listeners are live, which
  // silently skips every handler registered inside one.
  await waitFor(() => window.document.readyState === 'complete', {
    timeout: 5000,
    label: 'the document to finish parsing',
  });

  // The real files, executed in page order, exactly as the <script> tags load them.
  for (const name of scripts) {
    const el = window.document.createElement('script');
    el.textContent = readScript(name);
    window.document.body.appendChild(el);
  }

  // Now fire what deferred scripts wait on.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  window.dispatchEvent(new window.Event('load'));

  return {
    window,
    document: window.document,
    jar,
    clipboard,
    consoleErrors,
    /** Let queued microtasks and timers run - the client is asynchronous throughout. */
    settle: (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms)),
    $: (selector) => window.document.querySelector(selector),
    $id: (id) => window.document.getElementById(id),
    text: (selector) => window.document.querySelector(selector)?.textContent?.trim() ?? null,
    close: () => dom.window.close(),
  };
}

/** Wait until a predicate holds, so tests key off state rather than arbitrary sleeps. */
async function waitFor(predicate, { timeout = 2000, interval = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let result;
    try {
      result = predicate();
    } catch {
      result = false;
    }
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

module.exports = { openPage, renderPage, waitFor };
