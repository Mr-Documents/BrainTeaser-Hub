'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp } = require('../helpers/testApp');
const { createErrorReporter, redact } = require('../../src/lib/errorReporter');

/**
 * The endpoints and plumbing an orchestrator depends on.
 *
 * These are easy to break without noticing, because nothing in the product surface uses them -
 * and the failure mode is a restart loop or a silently unmonitored crash in production.
 */

test.describe('liveness and readiness', () => {
  test('/healthz answers without touching storage', async () => {
    const { app, repository } = buildTestApp();

    // The whole point of liveness: a dead database must not make the orchestrator kill a
    // process that is otherwise perfectly able to serve.
    repository.healthCheck = async () => {
      throw new Error('database is on fire');
    };

    const res = await request(app).get('/healthz').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'up');
    assert.equal(typeof res.body.uptimeSec, 'number');
  });

  test('/readyz reports ready when storage answers', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/readyz').expect(200);

    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, 'ready');
    assert.equal(res.body.driver, 'memory');
  });

  test('/readyz returns 503 when storage is unreachable', async () => {
    const { app, repository } = buildTestApp();
    repository.healthCheck = async () => {
      throw new Error('connection refused');
    };

    const res = await request(app).get('/readyz').expect(503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, 'not-ready');
  });

  test('/readyz returns 503 when storage reports itself unhealthy', async () => {
    const { app, repository } = buildTestApp();
    repository.healthCheck = async () => ({ ok: false, driver: 'memory' });

    const res = await request(app).get('/readyz').expect(503);
    assert.equal(res.body.ok, false);
  });

  test('readiness and liveness disagree when storage is down - which is the point', async () => {
    const { app, repository } = buildTestApp();
    repository.healthCheck = async () => {
      throw new Error('down');
    };

    await request(app).get('/healthz').expect(200); // keep me alive
    await request(app).get('/readyz').expect(503); // but send me no traffic
  });
});

test.describe('crawler directives', () => {
  test('robots.txt keeps private and account routes out of search results', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get('/robots.txt')
      .expect(200)
      .expect('Content-Type', /text\/plain/);

    for (const path of ['/admin', '/profile', '/signin', '/signup', '/auth/']) {
      assert.match(res.text, new RegExp(`Disallow: ${path.replace('/', '\\/')}`), `${path} must be disallowed`);
    }
    assert.match(res.text, /Sitemap: https?:\/\/[^/]+\/sitemap\.xml/);
  });

  test('sitemap.xml lists the public pages as valid XML', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/sitemap.xml').expect(200).expect('Content-Type', /xml/);

    assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(res.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);

    for (const path of ['/play', '/daily', '/leaderboard', '/how-it-works']) {
      assert.match(res.text, new RegExp(`<loc>https?://[^<]+${path.replace('/', '\\/')}</loc>`));
    }
  });

  test('the sitemap never advertises a private page', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/sitemap.xml').expect(200);

    for (const path of ['/admin', '/profile', '/signin', '/signup']) {
      assert.doesNotMatch(res.text, new RegExp(`<loc>[^<]*${path.replace('/', '\\/')}</loc>`));
    }
  });
});

test.describe('error reporting', () => {
  test('credentials are redacted before a report leaves the process', () => {
    const cleaned = redact({
      requestId: 'abc',
      adminToken: 'super-secret',
      user: { email: 'a@b.c', sessionCookie: 'signed-value' },
      nested: { apiKey: 'k', deep: { password: 'p' } },
    });

    assert.equal(cleaned.requestId, 'abc', 'safe fields survive');
    assert.equal(cleaned.adminToken, '[redacted]');
    assert.equal(cleaned.user.sessionCookie, '[redacted]');
    assert.equal(cleaned.nested.apiKey, '[redacted]');
    assert.equal(cleaned.nested.deep.password, '[redacted]');
    assert.equal(cleaned.user.email, 'a@b.c');
  });

  test('redaction survives arrays and cannot recurse forever', () => {
    const looping = { name: 'x' };
    looping.self = looping;

    const cleaned = redact(looping);
    assert.doesNotThrow(() => redact(looping), 'a cyclic object must not hang the reporter');
    assert.equal(cleaned.self, '[circular]', 'the cycle is replaced, not merely depth-capped');
    assert.doesNotThrow(() => JSON.stringify(cleaned), 'the result must be safe for any sink');
    assert.deepEqual(redact([{ token: 't' }, { ok: 1 }]), [{ token: '[redacted]' }, { ok: 1 }]);
  });

  test('a report reaches the configured sink with a release stamp', () => {
    const events = [];
    const reporter = createErrorReporter({
      logger: { error() {} },
      sink: (event) => events.push(event),
      release: 'abc1234',
      env: 'production',
    });

    reporter.report(new Error('boom'), { requestId: 'r-1' });

    assert.equal(events.length, 1);
    assert.equal(events[0].message, 'boom');
    assert.equal(events[0].release, 'abc1234');
    assert.equal(events[0].env, 'production');
    assert.equal(events[0].context.requestId, 'r-1');
    assert.ok(events[0].stack);
  });

  test('a broken sink cannot take the process down', () => {
    const logged = [];
    const reporter = createErrorReporter({
      logger: { error: (m) => logged.push(m) },
      sink: () => {
        throw new Error('reporting service is down');
      },
    });

    assert.doesNotThrow(() => reporter.report(new Error('original failure')));
    // The original error must still be logged even though the sink failed.
    assert.ok(logged.some((m) => m.includes('original failure')));
  });

  test('a non-Error value can still be reported', () => {
    const events = [];
    const reporter = createErrorReporter({ logger: { error() {} }, sink: (e) => events.push(e) });

    reporter.report('a bare string rejection');
    assert.equal(events[0].message, 'a bare string rejection');
  });
});
