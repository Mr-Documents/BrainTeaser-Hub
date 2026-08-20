# 🧠 Brain Teaser Hub

Curated logic, math, word, lateral-thinking and trivia puzzles, graded easy / medium / hard, with
server-side hints, penalty-and-bonus scoring, daily challenges, streaks, a live leaderboard and
shareable challenge links.

Express + EJS on the server, Supabase (Postgres) for storage, zero front-end build step.

---

## Quick start

```bash
npm install
npm run build:css
npm run dev              # http://localhost:3000
```

That's it. With no `.env`, the app runs on the JSON file driver with all 88 seeded puzzles, so a
fresh clone is playable immediately.

To point it at Supabase:

```bash
cp .env.example .env     # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + ADMIN_TOKEN
npm run db:push          # checks the remote schema and tells you what to apply
npm run db:seed          # loads data/puzzles.seed.json into Supabase
npm run dev
```

---

## Setting up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → API**: copy the **Project URL** and the **`service_role`** key into `.env`.
   The service-role key bypasses row level security and must stay server-side - never ship it to a
   browser, never commit it.
3. Apply the schema **in order**, either way:
   - **Dashboard**: SQL Editor → New query → paste [`0001_init.sql`](supabase/migrations/0001_init.sql), Run → then [`0002_auth.sql`](supabase/migrations/0002_auth.sql), Run.
   - **CLI**: `supabase link --project-ref <ref>` then `supabase db push`.
4. `npm run db:push` to confirm every table and view landed.
5. `npm run db:seed` to load the puzzle catalogue.
6. For Google sign-in: **Authentication -> Providers -> Google** in the Supabase dashboard, then
   set `OAUTH_PROVIDERS=google` in `.env`. Leave it empty for email-only sign-in.

The migration creates `puzzles`, `players` and `attempts`, an atomic `record_solve()` function,
three read-model views for the charts, and RLS policies that leave the anon key able to read public
data and nothing else.

---

## Scripts

| Command                           | What it does                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `npm run dev`                     | Development server with reload                                 |
| `npm start`                       | Production server                                              |
| `npm run build:css`               | Compile SCSS → `public/css/main.css`                           |
| `npm run watch:css`               | Recompile SCSS on change                                       |
| `npm test`                        | Full test suite (Node's built-in runner)                       |
| `npm run test:coverage`           | Same, with coverage                                            |
| `npm run lint` / `lint:fix`       | ESLint                                                         |
| `npm run format` / `format:check` | Prettier                                                       |
| `npm run db:push`                 | Verify the Supabase schema                                     |
| `npm run db:seed`                 | Import `data/puzzles.seed.json` (`--dry-run` to validate only) |
| `npm run verify`                  | lint + build + test - what CI runs                             |

---

## Architecture

The dependency arrow points one way only: HTTP → services → domain, with storage behind an
interface. Nothing in `domain/` knows what a request or a database is, which is why it is tested
directly and exhaustively.

```
src/
├── auth/            Sign-in behind one contract: supabase (real) or local (log + tests).
├── domain/          Pure rules - no I/O, no framework. Deterministic and fully unit tested.
│   ├── scoring.js         penalties, speed bonus, streak multiplier
│   ├── answerMatcher.js   forgiving answer comparison (exact / partial / regex)
│   ├── puzzlePicker.js    random + deterministic daily selection
│   ├── puzzleSchema.js    zod validation and the public projection
│   └── streak.js          daily streak arithmetic
├── repositories/    Storage behind one contract.
│   ├── jsonRepository.js      files (default) - also the in-memory driver for tests
│   └── supabaseRepository.js  Postgres via supabase-js
├── services/        Use cases: puzzleService, gameService, statsService, accountService
├── http/            Express only - app factory, routes, middleware
└── server.js        Entry point: config validation, listen, graceful shutdown
```

**Why it is shaped this way**

- **Storage is a config choice, not a code change.** `DATA_DRIVER` selects the driver; every layer
  above it is written against one interface. That is what lets the whole test suite run against an
  in-memory store with no mocking framework and no database.
- **`createApp(overrides)` takes its dependencies as arguments.** Tests inject a repository, a
  logger and a config, so there is not a single module-level mock in the suite.
- **Scoring state lives on the server.** Hint counts, wrong guesses and solve timing are held
  against an opaque attempt token. The browser never receives an answer, so the score cannot be
  forged by editing the page or replaying a request.
- **Aggregates are computed in Postgres.** Stats read from views instead of pulling the whole
  `attempts` table across the wire.

---

## Scoring

```
earned = max(0, base - 15×hints - 10×wrongGuesses)
total  = round((earned + speedBonus) × streakMultiplier)
```

- **Speed bonus** - up to 25% of base under 20 seconds, tapering to zero at two minutes.
- **Streak multiplier** - +5% per consecutive UTC day solved, capped at ×1.5.
- Penalties apply **before** bonuses, so a heavily hinted solve can never out-earn a clean one.
- A puzzle already solved in the current session scores zero.

Answer matching is deliberately forgiving: case, accents, punctuation, a leading `a/an/the` and
spelled-out numbers are normalised away, so `Echo`, `an echo`, `ECHO!` and `écho` are one answer,
and `8` matches `eight`.

---

## Accounts

Sign-in is **optional and never gates play**. Anonymous visitors get every puzzle, every hint, the
timer, the score and shareable links - they just are not ranked, because a leaderboard entry has to
belong to somebody.

|                                  | Anonymous | Signed in |
| -------------------------------- | --------- | --------- |
| Play, hints, timer, share        | yes       | yes       |
| Sees what a solve was worth      | yes       | yes       |
| Ranked on the leaderboard        | no        | yes       |
| Daily streak multiplier          | no        | yes       |
| Score follows you across devices | no        | yes       |

**Two ways in**, both landing in the same place: **Continue with Google** (one click), or a
passwordless **magic link** by email.

**How it works.** Both flows are driven entirely from the server: the browser never loads
the Supabase SDK and never holds a Supabase JWT. We verify the emailed token server-side and issue
our own signed, `httpOnly`, 30-day session cookie. That keeps the CSP free of third-party
`connect-src`, puts no token within reach of an XSS, and makes revocation a matter of rotating
`SESSION_SECRET`.

Google sign-in uses PKCE. The code verifier is parked in a separate signed, `httpOnly`,
10-minute cookie for the round trip, so a callback URL that leaks or is replayed cannot be
redeemed by anyone but the browser that started the handshake.

The scoring identity comes from that cookie, never from the request body - a username in a
`/api/submit` payload is ignored outright, which is what closes the old "type any name, take their
points" hole.

Display names are unique case-insensitively, validated, and collision-resolved on signup
(`ada`, `ada2`, …). Emails are never exposed: the public leaderboard reads a view that does not
contain the column.

**Local development** runs `AUTH_DRIVER=local`, which prints the sign-in link to the server log
instead of emailing it. Production refuses to boot on that driver, and refuses to boot without a
`SESSION_SECRET`.

---

## The puzzle studio (`/admin`)

- Draft a puzzle with live character counts, an auto-derived slug and per-level point suggestions.
- **Test the matcher** before saving - type what a player might submit and see it graded against
  the unsaved draft.
- Search and filter the catalogue; edit, preview or delete inline.
- Publish/draft toggle, bulk JSON import, and a re-importable export.
- Validation failures come back as per-field issues and are painted next to the offending input.

Protected by a shared `ADMIN_TOKEN`, exchanged once for a signed, expiring, `httpOnly` cookie.
Auth is **required automatically in production** and the server refuses to boot without a token set.

---

## API

| Method                | Route                                         | Purpose                                                       |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `GET`                 | `/api/puzzles/random`                         | Serve a puzzle + attempt token. `?type=&difficulty=&exclude=` |
| `GET`                 | `/api/puzzles/daily`                          | The same puzzle for everyone, per UTC day                     |
| `GET`                 | `/api/puzzles/:id`                            | Open an attempt on a specific puzzle                          |
| `GET`                 | `/api/puzzles/:id/hint`                       | Reveal the next hint (`?attemptToken=`)                       |
| `POST`                | `/api/submit`                                 | Grade an answer and award points                              |
| `GET`                 | `/api/leaderboard`                            | Top players                                                   |
| `GET`                 | `/api/stats`                                  | Global chart data                                             |
| `GET`                 | `/api/health`                                 | Storage health + uptime                                       |
| `GET/POST/PUT/DELETE` | `/api/admin/puzzles`                          | CRUD (admin)                                                  |
| `POST`                | `/api/admin/puzzles/validate`                 | Dry-run a draft (admin)                                       |
| `POST`                | `/api/admin/import` · `GET /api/admin/export` | Bulk transfer (admin)                                         |

Every response uses one envelope: `{ ok: true, data }` or `{ ok: false, error, code, details? }`.

---

## Testing & CI

Two suites, on Node's built-in runner - no Jest, no Vitest, no mocking library.

**`npm test`** - 294 tests, no network, runs anywhere.

- **Unit** - scoring maths, answer matching, puzzle selection, validation, streaks, attempt
  store, colour contrast, form-control styling, seed hydration.
- **Integration** - the real Express app over HTTP via supertest: the full play loop, hint
  sequencing, attempt-token forgery, both sign-in flows, the OAuth handshake, admin auth and
  CRUD, page rendering, health probes, error shapes and security headers.
- **Browser** (`tests/browser/`) - the 1,200 lines under `public/js`, driven through jsdom
  against the _real_ rendered HTML, with `fetch` routed back into the _real_ Express app. Not
  fixtures: a renamed element id, a changed response field or a broken event handler fails
  here, and nowhere else. Run alone with `npm run test:browser`.

**`npm run test:supabase`** - 42 tests against a real Postgres. This is the suite the others
cannot replace: it is the only place a wrong column name, a mismatched RPC signature, a broken
view or a bad PKCE challenge can actually surface. It covers the snake_case mapping, database
check constraints, the `updated_at` trigger, `record_solve` under concurrent writes, `on delete
cascade`, the stats views, and that the PKCE challenge Google receives really does derive from
the verifier we store.

It skips itself when no credentials are configured, so a fresh clone and forked PRs are
unaffected. Every row it creates carries a per-run prefix and is deleted in teardown, so it is
safe to point at a project with real data in it.

```bash
npm test              # fast, isolated
npm run test:supabase # requires .env credentials
npm run test:all      # both
```

`createRepository()` refuses to build a Supabase client while `NODE_ENV=test`, so a test that
forgets to inject its dependencies fails loudly instead of quietly reading production.

CI (`.github/workflows/ci.yml`) runs lint, format check, an SCSS rebuild with a staleness check,
catalogue validation and the suite on Node 20 and 22 - then boots the real server and probes it,
and audits dependencies.

---

## Security notes

- Answers, hints and explanations never reach the client before they are earned.
- Attempt tokens are opaque, server-side, TTL'd and bounded in number.
- Helmet CSP, no `x-powered-by`, rate limiting on `/api` and a tighter limit on `/api/submit`.
- Admin comparisons are constant-time; sessions are signed HMAC cookies, `httpOnly` and `secure` in production.
- Author-supplied regex answers are length-capped and screened for catastrophic backtracking.
- Internal errors are logged with a stack and returned as a generic message with a request id.

---

## Deploying

Full guide: **[DEPLOYING.md](DEPLOYING.md)**.

```bash
docker build -t brain-teaser-hub .
# or, without Docker:
npm ci --omit=dev && npm run build:css && npm start
```

Two health endpoints, answering different questions - wiring them the wrong way round causes
restart loops:

| Endpoint   | Question               | Use for         |
| ---------- | ---------------------- | --------------- |
| `/healthz` | Is the process alive?  | Liveness probe  |
| `/readyz`  | Should it get traffic? | Readiness probe |

`/healthz` deliberately checks nothing external, so a database blip cannot make an orchestrator
kill healthy containers. `/readyz` does check storage, so a struggling instance leaves the
rotation without being restarted.

The server validates its configuration on boot and **refuses to start** on a missing
`ADMIN_TOKEN`, a missing `SESSION_SECRET`, or `AUTH_DRIVER=local` in production. `SIGTERM` drains
in-flight requests before exit; a second signal exits immediately.
