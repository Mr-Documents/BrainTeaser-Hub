# Deploying Brain Teaser Hub

The app is a single stateless Node process in front of Supabase. Anything that can run a
container or a Node buildpack will host it.

---

## Before the first deploy

**1. Apply the database schema.** Supabase Dashboard → SQL Editor, run in order:

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_auth.sql
```

Verify with `npm run db:push`, then load the catalogue with `npm run db:seed`.

**2. Generate the secrets.**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ADMIN_TOKEN
```

**3. Set the environment.** These are the ones production actually requires:

| Variable                    | Why it is required                                        |
| --------------------------- | --------------------------------------------------------- |
| `NODE_ENV=production`       | Enables secure cookies, rate limiting, caching, JSON logs |
| `SUPABASE_URL`              | Project URL - no trailing path                            |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only; bypasses RLS                            |
| `SESSION_SECRET`            | Signs player sessions. Rotating it signs everyone out     |
| `ADMIN_TOKEN`               | Without it the server refuses to boot                     |
| `PUBLIC_BASE_URL`           | Canonical origin, e.g. `https://brainteasers.example.com` |

`PUBLIC_BASE_URL` is a security requirement, not a nicety. Sign-in links are absolute URLs; if
the origin were derived from the request's `Host` header, an attacker could request a link for
somebody else's address with a forged `Host` and receive their single-use token when the victim
clicks the email. The server refuses to boot in production without it.

Optional: `OAUTH_PROVIDERS=google` (must also be enabled in Supabase → Authentication →
Providers), `LOG_LEVEL`, `SHUTDOWN_GRACE_MS`, `RELEASE`.

**The server validates all of this on boot and refuses to start if it is wrong** - a missing
`ADMIN_TOKEN`, a `SESSION_SECRET` you forgot, or `AUTH_DRIVER=local` in production are all
startup failures rather than silent security holes.

---

## Health endpoints

Two, and they answer different questions. Wiring them the wrong way round causes restart loops.

| Endpoint   | Question               | Point it at                                |
| ---------- | ---------------------- | ------------------------------------------ |
| `/healthz` | Is the process alive?  | **Liveness** probe / container healthcheck |
| `/readyz`  | Should it get traffic? | **Readiness** probe / load-balancer        |

`/healthz` deliberately touches nothing external. If it checked the database, a brief Supabase
blip would make the orchestrator kill every healthy container and turn a small outage into a
large one. `/readyz` does check storage, so a struggling instance leaves the rotation without
being destroyed.

---

## Docker

```bash
docker build -t brain-teaser-hub .

docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e SUPABASE_URL=https://YOUR-REF.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e SESSION_SECRET=... \
  -e ADMIN_TOKEN=... \
  -e PUBLIC_BASE_URL=https://your-domain \
  brain-teaser-hub
```

The image is multi-stage: SCSS is compiled in a builder stage, production dependencies are
resolved in a separate stage, and the runtime carries neither the build tooling nor the dev
dependencies. It runs as the unprivileged `node` user and uses `dumb-init` as PID 1 so `SIGTERM`
reaches Node and the graceful-shutdown path actually runs on every deploy.

Verified on the built image (`node:22-alpine`, ~284 MB):

| Property            | Result                                                             |
| ------------------- | ------------------------------------------------------------------ |
| Process user        | `uid=1000(node)` - not root                                        |
| Dev dependencies    | none present (`sass`, `eslint`, `supertest`, `nodemon` all absent) |
| Compiled stylesheet | present, built in-image rather than copied from the context        |
| `.env`              | not in any layer                                                   |
| `HEALTHCHECK`       | reports `healthy`                                                  |
| `docker stop`       | drains and exits **0**, no force-kill                              |

If `docker` is not on your PATH, Docker Desktop may be a per-user install - the CLI then
lives under `%LOCALAPPDATA%/Programs/DockerDesktop/resources/bin`.

---

## Deploying to Render

Render is the recommended host for this app: it runs the Dockerfile as a persistent process and
redeploys on every push to `main`, with no CLI and no CI wiring.

**Use the Starter plan, not Free.** The free plan sleeps after 15 minutes of inactivity, which
both wipes in-flight play sessions (hint counts and timers live in process memory) and adds a
~50 second cold start for the next visitor.

### Option A - the dashboard (simplest)

1. **New → Web Service**, connect the repository.
2. **Runtime: Docker.** Render detects the `Dockerfile`; leave the build and start commands empty.
3. **Plan: Starter.**
4. **Health Check Path: `/healthz`.**
5. Add the environment variables below, then **Create Web Service**.

| Variable                    | Value                                             |
| --------------------------- | ------------------------------------------------- |
| `NODE_ENV`                  | `production`                                      |
| `SUPABASE_URL`              | your project URL                                  |
| `SUPABASE_SERVICE_ROLE_KEY` | your service-role key                             |
| `SESSION_SECRET`            | click **Generate**                                |
| `ADMIN_TOKEN`               | click **Generate**, then copy it somewhere safe   |
| `PUBLIC_BASE_URL`           | your `*.onrender.com` host, or your custom domain |
| `OAUTH_PROVIDERS`           | leave empty, or `google` once enabled in Supabase |

You do not need to prefix `PUBLIC_BASE_URL` with `https://` - a bare hostname is normalised into
a full origin on boot.

### Option B - the blueprint

`render.yaml` in the repo describes the same service, so the deployment is reviewable in git
rather than living only in a browser. **New → Blueprint**, point it at the repo, and supply the
two Supabase secrets when prompted; the rest is filled in for you, including `SESSION_SECRET`
and `ADMIN_TOKEN` as generated values and `PUBLIC_BASE_URL` from the service's own hostname.

If Render rejects the `runtime:` key, your account is on the older blueprint schema - change it
to `env: docker`.

### After the first deploy

1. Read `ADMIN_TOKEN` out of the Render dashboard (Environment tab) and sign in at `/admin`.
2. Set up SMTP under **Supabase → Authentication → Email**. The built-in mailer allows only a
   handful of sends per hour, so sign-in will start failing silently under real traffic.
3. If you attach a custom domain, update `PUBLIC_BASE_URL` to match and redeploy - otherwise
   sign-in links keep pointing at the old `onrender.com` host.

### Verified against the real image

The container was run under Render-like conditions (`PORT` injected, `NODE_ENV=production`, a
bare hostname in `PUBLIC_BASE_URL`, live Supabase) and checked:

|                              |                                                   |
| ---------------------------- | ------------------------------------------------- |
| Binds to the injected `PORT` | yes, listened on 10000                            |
| `/healthz`                   | `200` - what Render polls                         |
| `/readyz`                    | `ready`, driver `supabase`                        |
| Canonical origin             | bare host normalised to `https://...onrender.com` |
| Forged `Host` header         | ignored - cannot poison generated links           |
| Admin without a token        | `302` / `401`; `200` with it                      |
| Missing `PUBLIC_BASE_URL`    | refuses to boot, with the reason                  |
| `SIGTERM`                    | drains and exits `0`                              |

---

## Other hosts

**Fly.io** - `fly launch --no-deploy`, then `fly secrets set ...` and `fly deploy`. Cheaper and
restarts far faster, but needs a GitHub Action to match Render's deploy-on-push. Set
`min_machines_running = 1`; the generated config stops idle machines, which wipes play sessions.

**Railway** - detects the Dockerfile automatically; `RELEASE` is populated from
`RAILWAY_GIT_COMMIT_SHA` for you.

**Serverless (Vercel, Netlify Functions, Cloudflare Workers) will not work** as the app stands.
Play sessions live in process memory, so a request that lands on a different instance than the
one that served the puzzle cannot resolve its attempt token, and every submission fails. Swap
`src/lib/attemptStore.js` for a Redis-backed implementation first.

**Anything behind a proxy** - `trust proxy` is already enabled in production, which is what makes
`Secure` cookies and per-IP rate limiting work correctly. Covered by
`tests/integration/production.test.js`.

## After deploying

```bash
curl https://your-domain/healthz     # {"ok":true,"status":"up",...}
curl https://your-domain/readyz      # {"ok":true,"status":"ready","driver":"supabase"}
curl https://your-domain/api/health  # includes the live puzzle count
```

Then check `/robots.txt` and `/sitemap.xml` reflect your real domain, and sign in once to confirm
email delivery works.

---

## Error tracking

`src/lib/errorReporter.js` is the single place every unexpected error passes through. It logs by
default, which is enough on any host that retains stdout.

To send crashes to a service instead, pass a `sink` in `src/server.js`:

```js
const reporter = createErrorReporter({
  logger,
  env: config.env,
  release: process.env.RELEASE,
  sink: (event) => Sentry.captureException(event),
});
```

Context is redacted before it reaches the sink - anything whose key matches
`token|secret|key|password|cookie|authorization|session` is replaced, cycles are broken, and the
result is always safe to serialise.

---

## Operational notes

**Email limits.** Supabase's built-in mailer allows only a handful of sends per hour and is
intended for testing. Configure your own SMTP under Authentication → Email before real traffic,
or magic-link sign-in will start failing silently for users.

**One instance for now.** Play sessions (hint counts, wrong guesses, solve timing) live in
process memory, so a restart drops in-flight puzzles and two instances would not share them.
This is fine for an MVP. To scale horizontally, swap `src/lib/attemptStore.js` for a
Redis-backed implementation of the same interface - nothing else changes.

**Backups.** Supabase's free tier retains limited backups. Check the retention on your plan
before you have data worth losing. `GET /api/admin/export` produces a re-importable JSON copy of
the whole puzzle catalogue.

**Rotating secrets.** Changing `SESSION_SECRET` signs every player out. Changing `ADMIN_TOKEN`
invalidates admin sessions. Neither loses data.
