/**
 * Shared browser utilities: navigation, theme, toasts and the API client.
 * Loaded on every page; exposes everything under `window.BTH`.
 */
(function () {
  'use strict';

  // --------------------------------------------------------------- API client

  /**
   * Call the JSON API and unwrap the { ok, data } envelope.
   * @throws {Error} with `.status` and `.details` when the server reports a failure.
   */
  async function api(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(path, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* a proxy or gateway returned non-JSON */
    }

    if (!response.ok || !payload || payload.ok === false) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload?.code;
      error.details = payload?.details;
      throw error;
    }
    return payload.data;
  }

  // ------------------------------------------------------------------- toasts

  function toast(message, kind = 'info', timeout = 3600) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const node = document.createElement('div');
    node.className = `toast toast--${kind}`;
    node.textContent = message;
    stack.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-visible'));
    setTimeout(() => {
      node.classList.remove('is-visible');
      node.addEventListener('transitionend', () => node.remove(), { once: true });
      setTimeout(() => node.remove(), 600);
    }, timeout);
  }

  // ------------------------------------------------------------------ helpers

  const el = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** localStorage that degrades to a no-op in private mode rather than throwing. */
  const storage = {
    get(key, fallback = null) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* quota or disabled storage — the feature is a nicety, not a requirement */
      }
    },
  };

  function readBootstrap() {
    const node = el('bootstrap-data');
    if (!node) return {};
    try {
      return JSON.parse(node.textContent);
    } catch {
      return {};
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs a secure context; fall back to a hidden textarea.
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        return copied;
      } catch {
        return false;
      }
    }
  }

  // -------------------------------------------------------------- mobile menu

  function initNav() {
    const nav = document.querySelector('[data-nav]');
    const toggle = document.querySelector('[data-nav-toggle]');
    if (!nav || !toggle) return;

    const setOpen = (open) => {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    };

    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
    // Leaving the mobile breakpoint must not strand the page in the open state.
    window.matchMedia('(min-width: 860px)').addEventListener('change', (event) => {
      if (event.matches) setOpen(false);
    });
  }

  // --------------------------------------------------------------- theme

  const THEME_KEY = 'bth:theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.querySelector('[data-theme-icon]');
    if (icon) icon.textContent = theme === 'light' ? '☀' : '☾';
  }

  function initTheme() {
    const stored = storage.get(THEME_KEY);
    const preferred = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    applyTheme(preferred);

    const toggle = document.querySelector('[data-theme-toggle]');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      storage.set(THEME_KEY, next);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
    initTheme();
  });

  // The theme is applied as early as possible to avoid a flash of the wrong palette.
  applyTheme(
    storage.get(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  );

  window.BTH = { api, toast, el, escapeHtml, storage, readBootstrap, copyToClipboard };
})();
