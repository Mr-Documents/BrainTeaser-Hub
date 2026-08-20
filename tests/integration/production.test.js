'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildProductionApp, makePuzzle } = require('../helpers/testApp');

/**
 * The configuration paths that only exist in production.
 *
 * Everything else in the suite runs with `isProduction: false`, so trust-proxy handling, secure
 * cookies, rate limiting and asset caching were entirely unexercised. They are also the settings
 * whose failure modes are worst: a wrong proxy setting breaks sign-in for everyone, and a shared
 * rate-limit key lets one visitor lock out the whole site.
 */

/** Headers a TLS-terminating proxy adds - which is how essentially every host runs. */
const behindProxy = (req, ip = '203.0.113.10') =>
  req.set('X-Forwarded-Proto', 'https').set('X-Forwarded-For', ip).set('Host', 'brainteasers.example.com');

test.describe('behind a TLS-terminating proxy', () => {
  test('generated links use https, not the scheme of the internal hop', async () => {
    const { app, issuedLinks } = buildProductionApp();

    await behindProxy(request(app).post('/signin')).send({ email: 'ada@example.com' }).expect(200);

    const link = issuedLinks.at(-1).link;
    assert.match(link, /^https:\/\/brainteasers\.example\.com\//, `magic link was ${link}`);
  });

  test('robots and the sitemap advertise the public origin', async () => {
    const { app } = buildProductionApp();

    const sitemap = await behindProxy(request(app).get('/sitemap.xml')).expect(200);
    assert.match(sitemap.text, /<loc>https:\/\/brainteasers\.example\.com\/<\/loc>/);
    assert.doesNotMatch(sitemap.text, /<loc>http:\/\//, 'no plaintext URLs may be published');

    const robots = await behindProxy(request(app).get('/robots.txt')).expect(200);
    assert.match(robots.text, /Sitemap: https:\/\/brainteasers\.example\.com\/sitemap\.xml/);
  });

  test('a forged Host header cannot poison a sign-in link', async () => {
    // The attack this closes: request a link for somebody else's address with a forged Host,
    // and their single-use token is delivered to your domain when they click the email.
    // Pinning PUBLIC_BASE_URL is what prevents it - which is why production refuses to boot
    // without one.
    const { app, issuedLinks } = buildProductionApp({ baseUrl: 'https://brainteasers.example.com' });

    await request(app)
      .post('/signin')
      .set('X-Forwarded-Proto', 'https')
      .set('Host', 'attacker.example.com')
      .send({ email: 'victim@example.com' })
      .expect(200);

    const link = issuedLinks.at(-1).link;
    assert.match(link, /^https:\/\/brainteasers\.example\.com\//, `link pointed at ${link}`);
    assert.doesNotMatch(link, /attacker\.example\.com/, 'the token must never leave our origin');
  });

  test('a pinned origin also fixes robots and the sitemap', async () => {
    const { app } = buildProductionApp({ baseUrl: 'https://brainteasers.example.com' });

    const sitemap = await request(app).get('/sitemap.xml').set('Host', 'attacker.example.com').expect(200);
    assert.doesNotMatch(sitemap.text, /attacker\.example\.com/);

    const robots = await request(app).get('/robots.txt').set('Host', 'attacker.example.com').expect(200);
    assert.doesNotMatch(robots.text, /attacker\.example\.com/);
  });
});

test.describe('production refuses to boot when misconfigured', () => {
  const { validateConfig, config } = require('../../src/config');

  const productionConfig = (overrides = {}) => ({
    ...config,
    isProduction: true,
    auth: { ...config.auth, driver: 'supabase', sessionSecret: 'secret', ...(overrides.auth || {}) },
    admin: { ...config.admin, required: true, token: 'token', ...(overrides.admin || {}) },
    data: { ...config.data, driver: 'supabase' },
    site: { ...config.site, baseUrl: 'https://example.com', ...(overrides.site || {}) },
  });

  test('a valid production config passes', () => {
    assert.deepEqual(validateConfig(productionConfig()), []);
  });

  test('without PUBLIC_BASE_URL', () => {
    assert.throws(() => validateConfig(productionConfig({ site: { baseUrl: '' } })), /PUBLIC_BASE_URL/);
  });

  test('without SESSION_SECRET', () => {
    assert.throws(() => validateConfig(productionConfig({ auth: { sessionSecret: '' } })), /SESSION_SECRET/);
  });

  test('without ADMIN_TOKEN', () => {
    assert.throws(() => validateConfig(productionConfig({ admin: { token: '' } })), /ADMIN_TOKEN/);
  });

  test('with the local auth driver, which prints sign-in links to the log', () => {
    assert.throws(() => validateConfig(productionConfig({ auth: { driver: 'local' } })), /AUTH_DRIVER=local/);
  });
});

test.describe('cookies in production', () => {
  test('the player session cookie is Secure, HttpOnly and SameSite', async () => {
    const { app, issuedLinks } = buildProductionApp();

    await behindProxy(request(app).post('/signin')).send({ email: 'ada@example.com' });
    const link = issuedLinks.at(-1).link;
    const path = link.slice(link.indexOf('/auth/callback'));

    const res = await behindProxy(request(app).get(path)).expect(302);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('bth_session='));

    assert.match(cookie, /HttpOnly/i, 'no script may read a session');
    assert.match(cookie, /Secure/i, 'and it must never travel over plaintext');
    assert.match(cookie, /SameSite=Lax/i, 'which is also what blocks cross-site POSTs');
  });

  test('the admin session cookie is Secure too', async () => {
    const { app, config } = buildProductionApp();

    const res = await behindProxy(request(app).post('/admin/login')).send({ token: config.admin.token }).expect(302);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('bth_admin='));

    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
  });

  test('the OAuth handshake cookie is Secure', async () => {
    const { app } = buildProductionApp();

    const res = await behindProxy(request(app).post('/auth/google/start')).send({ next: '/play' }).expect(302);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('bth_oauth='));

    assert.match(cookie, /HttpOnly/i, 'the PKCE verifier is a secret');
    assert.match(cookie, /Secure/i);
  });
});

test.describe('rate limiting', () => {
  const startAttempt = async (app, ip) => {
    const res = await behindProxy(request(app).get('/api/puzzles/test-puzzle'), ip);
    return res.body.data.attemptToken;
  };

  const wrongAnswer = async (app, ip) => {
    const attemptToken = await startAttempt(app, ip);
    return behindProxy(request(app).post('/api/submit'), ip).send({
      puzzleId: 'test-puzzle',
      answer: 'not-the-answer',
      attemptToken,
    });
  };

  test('engages on the submit endpoint once the limit is passed', async () => {
    const { app } = buildProductionApp({ rateLimit: { submitMax: 3 } });

    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await wrongAnswer(app, '203.0.113.1')).status);

    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200], 'the first three are allowed');
    assert.deepEqual(statuses.slice(3), [429, 429], 'then it blocks');
  });

  test('is keyed per client, so one visitor cannot lock out the site', async () => {
    // The failure this guards against: without trust proxy every request carries the proxy's
    // own IP, so a single abusive client rate-limits every other user at once.
    const { app } = buildProductionApp({ rateLimit: { submitMax: 2 } });

    for (let i = 0; i < 4; i += 1) await wrongAnswer(app, '203.0.113.1');
    const blocked = await wrongAnswer(app, '203.0.113.1');
    assert.equal(blocked.status, 429, 'the noisy client is limited');

    const other = await wrongAnswer(app, '198.51.100.7');
    assert.equal(other.status, 200, 'a different client is unaffected');
  });

  test('a rate-limited response keeps the API envelope', async () => {
    const { app } = buildProductionApp({ rateLimit: { submitMax: 1 } });

    await wrongAnswer(app, '203.0.113.2');
    const blocked = await wrongAnswer(app, '203.0.113.2');

    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.ok, false, 'clients parse { ok, error } everywhere else');
    assert.equal(blocked.body.code, 'rate_limited');
    assert.match(blocked.body.error, /too many/i);
  });

  test('advertises the standard rate-limit headers', async () => {
    const { app } = buildProductionApp({ rateLimit: { submitMax: 3 } });
    const res = await wrongAnswer(app, '203.0.113.3');

    assert.ok(res.headers['ratelimit'] || res.headers['ratelimit-limit'], 'draft-7 headers are set');
    assert.equal(res.headers['x-ratelimit-limit'], undefined, 'and the legacy ones are not');
  });

  test('sign-in is limited far more tightly than play, because it sends email', async () => {
    const { app } = buildProductionApp();

    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await behindProxy(request(app).post('/signin'), '203.0.113.4').send({ email: 'ada@example.com' });
      statuses.push(res.status);
    }

    assert.ok(statuses.includes(429), `expected sign-in to be throttled, saw ${statuses.join(', ')}`);
  });

  test('reading a puzzle is not throttled at play speed', async () => {
    const { app } = buildProductionApp({ puzzles: [makePuzzle(), makePuzzle({ id: 'second' })] });

    for (let i = 0; i < 10; i += 1) {
      const res = await behindProxy(request(app).get('/api/puzzles/random'), '203.0.113.5');
      assert.notEqual(res.status, 429, `a normal player was throttled on request ${i + 1}`);
    }
  });
});

test.describe('asset caching and headers', () => {
  test('static assets are cached for a week', async () => {
    const { app } = buildProductionApp();
    const res = await request(app).get('/css/main.css').expect(200);

    assert.match(res.headers['cache-control'], /max-age=604800/, 'seven days');
    assert.ok(res.headers.etag, 'and revalidation is still possible');
  });

  test('pages are not cached, so a solve is never served stale', async () => {
    const { app } = buildProductionApp();
    const res = await request(app).get('/play').expect(200);
    assert.doesNotMatch(res.headers['cache-control'] || '', /max-age=604800/);
  });

  test('security headers are present on a production response', async () => {
    const { app } = buildProductionApp();
    const res = await behindProxy(request(app).get('/')).expect(200);

    assert.ok(res.headers['content-security-policy']);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['strict-transport-security'], 'HSTS matters once TLS is terminated upstream');
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});

test.describe('admin auth is mandatory in production', () => {
  test('the studio is closed to an anonymous visitor', async () => {
    const { app } = buildProductionApp();

    const page = await behindProxy(request(app).get('/admin')).expect(302);
    assert.match(page.headers.location, /^\/admin\/login/);

    await behindProxy(request(app).get('/api/admin/puzzles')).expect(401);
    await behindProxy(request(app).post('/api/admin/puzzles')).send(makePuzzle()).expect(401);
  });

  test('and open with the configured token', async () => {
    const { app, config } = buildProductionApp();
    await behindProxy(request(app).get('/api/admin/puzzles'))
      .set('Authorization', `Bearer ${config.admin.token}`)
      .expect(200);
  });
});
