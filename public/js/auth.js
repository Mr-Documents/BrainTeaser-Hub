/**
 * Progressive enhancement for the auth pages.
 *
 * Everything here is optional polish: the sign-in form, the resend button, the name form and
 * account deletion all work with JavaScript switched off, because they are ordinary form posts.
 * This layer adds inline validation, pending states and a resend cooldown.
 */
(function () {
  'use strict';

  const { api, el } = window.BTH;

  // Matches the server's check in accountService - kept deliberately permissive, since the
  // emailed link is what really proves an address works.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const RESEND_COOLDOWN_SECONDS = 45;

  // ------------------------------------------------------------- sign-in form

  function initSignInForm() {
    const form = document.querySelector('[data-auth-form]');
    if (!form) return;

    const input = el('email');
    const error = form.querySelector('[data-email-error]');
    const button = form.querySelector('[data-submit-button]');
    const label = form.querySelector('[data-submit-label]');

    const showError = (message) => {
      error.textContent = message;
      error.hidden = !message;
      input.classList.toggle('is-invalid', Boolean(message));
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    };

    // Validate on blur, not on every keystroke - shouting at someone mid-typing is hostile.
    input.addEventListener('blur', () => {
      const value = input.value.trim();
      if (value && !EMAIL_RE.test(value)) showError('That does not look like an email address.');
    });
    input.addEventListener('input', () => showError(''));

    form.addEventListener('submit', (event) => {
      const value = input.value.trim();
      if (!value || !EMAIL_RE.test(value)) {
        event.preventDefault();
        showError(value ? 'That does not look like an email address.' : 'Enter your email address.');
        input.focus();
        return;
      }
      // Sending email is not free, and a double-click should not spend two of them.
      button.disabled = true;
      label.textContent = 'Sending your link…';
      button.classList.add('is-loading');
    });
  }

  // ------------------------------------------------------- "check your inbox"

  /** Guess which webmail the address uses, and show only that shortcut. */
  function initMailShortcuts() {
    const box = document.querySelector('[data-mail-shortcuts]');
    if (!box) return;

    const address = document.querySelector('.auth-card__email')?.textContent?.trim().toLowerCase() || '';
    const domain = address.split('@')[1] || '';

    const providers = {
      Gmail: ['gmail.com', 'googlemail.com'],
      Outlook: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
      Yahoo: ['yahoo.com', 'yahoo.co.uk', 'ymail.com'],
    };

    let matched = false;
    for (const link of box.querySelectorAll('a')) {
      const domains = providers[link.textContent.trim()] || [];
      const isMatch = domains.includes(domain);
      link.hidden = !isMatch;
      if (isMatch) matched = true;
    }
    // Unknown provider: no useful shortcut to offer, so show nothing rather than three guesses.
    box.hidden = !matched;
  }

  function initResend() {
    const form = document.querySelector('[data-resend-form]');
    if (!form) return;

    const button = form.querySelector('[data-resend-button]');
    const timer = form.querySelector('[data-resend-timer]');
    let remaining = RESEND_COOLDOWN_SECONDS;

    const tick = () => {
      if (remaining <= 0) {
        button.disabled = false;
        timer.textContent = '';
        window.clearInterval(interval);
        return;
      }
      timer.textContent = ` (${remaining}s)`;
      remaining -= 1;
    };

    button.disabled = true;
    tick();
    const interval = window.setInterval(tick, 1000);

    form.addEventListener('submit', () => {
      button.disabled = true;
      timer.textContent = '';
    });
  }

  // ------------------------------------------------------- display name form

  function initNameForm() {
    const form = document.querySelector('[data-name-form]');
    if (!form) return;

    const input = form.querySelector('[data-name-input]');
    const status = form.querySelector('[data-name-status]');
    const submit = form.querySelector('[data-name-submit]');
    const currentName = input.dataset.currentName;

    let debounce = null;
    let inFlight = null;

    const setStatus = (text, state) => {
      status.textContent = text;
      status.className = `field__status${state ? ` is-${state}` : ''}`;
    };

    async function check() {
      const value = input.value.trim();

      if (!value || value === currentName) {
        setStatus('', null);
        submit.disabled = false;
        return;
      }

      setStatus('Checking…', 'pending');
      // Abandon the previous check so a fast typist cannot have an older answer land last.
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      try {
        const result = await api(`/api/account/name-available?name=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setStatus(result.available ? `"${result.name}" is available` : result.reason, result.available ? 'ok' : 'error');
        submit.disabled = !result.available;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // The server validates again on submit, so a failed check must not block saving.
        setStatus('', null);
        submit.disabled = false;
      }
    }

    input.addEventListener('input', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(check, 350);
    });
  }

  // ------------------------------------------------------------------- boot

  document.addEventListener('DOMContentLoaded', () => {
    initSignInForm();
    initMailShortcuts();
    initResend();
    initNameForm();
  });
})();
