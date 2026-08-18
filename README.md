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
   The service-role key bypasses row level security and must stay server-side — never ship it to a
   browser, never commit it.
3. Apply the schema, either way:
   - **Dashboard**: SQL Editor → New query → paste [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) → Run.
   - **CLI**: `supabase link --project-ref <ref>` then `supabase db push`.
4. `npm run db:push` to confirm every table and view landed.
5. `npm run db:seed` to load the puzzle catalogue.

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
| `npm run verify`                  | lint + build + test — what CI runs                             |

---

## Architecture

The dependency arrow points one way only: HTTP → services → domain, with storage behind an
interface. Nothing in `domain/` knows what a request or a database is, which is why it is tested
directly and exhaustively.

```
src/
├── domain/          Pure rules — no I/O, no framework. Deterministic and fully unit tested.
│   ├── scoring.js         penalties, speed bonus, streak multiplier
│   ├── answerMatcher.js   forgiving answer comparison (exact / partial / regex)
│   ├── puzzlePicker.js    random + deterministic daily selection
│   ├── puzzleSchema.js    zod validation and the public projection
│   └── streak.js          daily streak arithmetic
├── repositories/    Storage behind one contract.
│   ├── jsonRepository.js      files (default) — also the in-memory driver for tests
│   └── supabaseRepository.js  Postgres via supabase-js
├── services/        Use cases: puzzleService, gameService, statsService
├── http/            Express only — app factory, routes, middleware
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
earned = max(0, base − 15×hints − 10×wrongGuesses)
total  = round((earned + speedBonus) × streakMultiplier)
```

- **Speed bonus** — up to 25% of base under 20 seconds, tapering to zero at two minutes.
- **Streak multiplier** — +5% per consecutive UTC day solved, capped at ×1.5.
- Penalties apply **before** bonuses, so a heavily hinted solve can never out-earn a clean one.
- A puzzle already solved in the current session scores zero.

Answer matching is deliberately forgiving: case, accents, punctuation, a leading `a/an/the` and
spelled-out numbers are normalised away, so `Echo`, `an echo`, `ECHO!` and `écho` are one answer,
and `8` matches `eight`.

---

## The puzzle studio (`/admin`)

- Draft a puzzle with live character counts, an auto-derived slug and per-level point suggestions.
- **Test the matcher** before saving — type what a player might submit and see it graded against
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

137 tests across unit and integration, on Node's built-in runner — no Jest, no Vitest, no mocking
library.

- **Unit** — scoring maths, answer matching, puzzle selection, validation, streaks, attempt store.
- **Integration** — the real Express app over HTTP via supertest: the full play loop, hint
  sequencing, attempt-token forgery, admin auth and CRUD, page rendering, error shapes and
  security headers.

```bash
npm test
```

CI (`.github/workflows/ci.yml`) runs lint, format check, an SCSS rebuild with a staleness check,
catalogue validation and the suite on Node 20 and 22 — then boots the real server and probes it,
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

Set `NODE_ENV=production`, `ADMIN_TOKEN`, and the Supabase credentials. The server validates its
config on boot and refuses to start if admin auth is required without a token.

```bash
npm ci --omit=dev && npm run build:css && npm start
```

`GET /healthz` is the load-balancer probe; `SIGTERM` drains in-flight requests before exit.
