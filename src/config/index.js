'use strict';

const path = require('path');
require('dotenv').config();

const ROOT = path.join(__dirname, '..', '..');

const toBool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const env = process.env.NODE_ENV || 'development';

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
// The service-role key stays server-side only; it bypasses RLS and must never reach the browser.
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

/**
 * Which storage backend to use.
 * `supabase` when credentials are present, otherwise the JSON files under data/ so the app
 * still runs on a fresh clone with zero setup. Override with DATA_DRIVER=json|supabase|memory.
 */
const requestedDriver = (process.env.DATA_DRIVER || '').trim().toLowerCase();
const hasSupabaseCreds = Boolean(supabaseUrl && supabaseKey);
const driver = requestedDriver || (hasSupabaseCreds ? 'supabase' : 'json');

/**
 * Turn whatever the host supplies into a usable absolute origin.
 *
 * Hosts differ: Render's `fromService` yields a bare hostname ("app.onrender.com"), while most
 * people paste a full URL. Accepting both means one fewer way for a deploy to boot with an
 * origin that produces broken sign-in links.
 */
function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    // Origin only - a path here would be concatenated into every generated link.
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

const config = Object.freeze({
  env,
  isProduction: env === 'production',
  isTest: env === 'test',
  port: toInt(process.env.PORT, 3000),
  rootDir: ROOT,
  publicDir: path.join(ROOT, 'public'),
  viewsDir: path.join(ROOT, 'views'),
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  logLevel: process.env.LOG_LEVEL || (env === 'test' ? 'silent' : 'info'),

  data: Object.freeze({
    driver,
    hasSupabaseCreds,
  }),

  supabase: Object.freeze({
    url: supabaseUrl,
    key: supabaseKey,
    schema: process.env.SUPABASE_SCHEMA || 'public',
  }),

  auth: Object.freeze({
    // 'supabase' emails a real magic link; 'local' prints it to the log so a fresh clone works
    // with no project. Auto-selects the same way the data driver does.
    driver: (process.env.AUTH_DRIVER || '').trim().toLowerCase() || (hasSupabaseCreds ? 'supabase' : 'local'),
    // Signs the player session cookie. Falls back to the admin token so a single secret is enough
    // to get started, but should be its own value in production.
    sessionSecret: (process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || '').trim(),
    sessionMaxAgeMs: toInt(process.env.SESSION_DAYS, 30) * 24 * 60 * 60 * 1000,
    cookieName: 'bth_session',
    // Only providers listed here get a button. A provider that is not also enabled in the
    // Supabase dashboard would fail on click, so this is opt-in rather than assumed.
    // Defaults to google on the local driver so the flow is visible without any setup.
    oauthProviders: (process.env.OAUTH_PROVIDERS === undefined
      ? hasSupabaseCreds
        ? ''
        : 'google'
      : process.env.OAUTH_PROVIDERS
    )
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
    // The PKCE verifier lives here between leaving for the provider and coming back.
    oauthCookieName: 'bth_oauth',
    oauthTtlMs: 10 * 60 * 1000,
  }),

  admin: Object.freeze({
    // Admin writes are rejected outright when no token is configured in production.
    token: (process.env.ADMIN_TOKEN || '').trim(),
    // Leave open in dev so the MVP is usable straight after `git clone`.
    required: toBool(process.env.ADMIN_AUTH_REQUIRED, env === 'production'),
    cookieName: 'bth_admin',
    sessionMaxAgeMs: toInt(process.env.ADMIN_SESSION_HOURS, 12) * 60 * 60 * 1000,
  }),

  play: Object.freeze({
    attemptTtlMs: toInt(process.env.ATTEMPT_TTL_MINUTES, 240) * 60 * 1000,
    maxAttempts: toInt(process.env.MAX_ACTIVE_ATTEMPTS, 20000),
  }),

  rateLimit: Object.freeze({
    enabled: toBool(process.env.RATE_LIMIT_ENABLED, env === 'production'),
    windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    submitMax: toInt(process.env.RATE_LIMIT_SUBMIT_MAX, 40),
    apiMax: toInt(process.env.RATE_LIMIT_API_MAX, 240),
  }),

  site: Object.freeze({
    name: 'Brain Teaser Hub',
    tagline: 'Logic · Math · Word · Lateral',
    baseUrl: normalizeOrigin(process.env.PUBLIC_BASE_URL),
  }),
});

/**
 * Fail fast on misconfiguration that would otherwise surface as a runtime 500.
 * @returns {string[]} warnings worth logging but not worth refusing to boot over
 */
function validateConfig(cfg = config) {
  const warnings = [];

  if (cfg.data.driver === 'supabase' && !cfg.data.hasSupabaseCreds) {
    throw new Error(
      'DATA_DRIVER=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing. See .env.example.'
    );
  }
  if (cfg.isProduction && cfg.admin.required && !cfg.admin.token) {
    throw new Error('ADMIN_TOKEN must be set in production - admin routes would otherwise be unprotected.');
  }
  if (cfg.isProduction && cfg.auth.driver === 'local') {
    throw new Error(
      'AUTH_DRIVER=local prints sign-in links to the log, which would let anyone reading it sign in as any user. Configure Supabase Auth for production.'
    );
  }
  if (cfg.isProduction && !cfg.auth.sessionSecret) {
    throw new Error('SESSION_SECRET must be set in production - player sessions cannot be signed without it.');
  }
  if (cfg.isProduction && !cfg.site.baseUrl) {
    // Without this, an absolute URL is built from the request's Host header. An attacker can
    // then request a sign-in link for somebody else's address with a forged Host, and the
    // victim's single-use token is delivered to the attacker's domain when they click it.
    // Pinning the origin is the fix; refusing to boot is how we guarantee it is pinned.
    throw new Error(
      'PUBLIC_BASE_URL must be set in production. Sign-in links are absolute URLs, and deriving ' +
        'them from the Host header lets an attacker redirect somebody else’s sign-in token to their own domain.'
    );
  }
  if (!cfg.isProduction && cfg.auth.driver === 'local') {
    warnings.push('Auth driver is "local" - sign-in links are printed to this log instead of emailed.');
  }
  if (cfg.isProduction && cfg.data.driver === 'json') {
    warnings.push('Running in production on the JSON file driver - data will not survive a redeploy.');
  }
  if (!cfg.isProduction && !cfg.admin.token) {
    warnings.push('No ADMIN_TOKEN set - admin routes are open. Fine locally, never in production.');
  }
  return warnings;
}

module.exports = { config, validateConfig };
