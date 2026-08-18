-- ============================================================================
-- Brain Teaser Hub - initial schema
--
-- Apply with either:
--   supabase db push                        (Supabase CLI, from the repo root)
--   or paste this file into the SQL editor  (Supabase dashboard → SQL → New query)
--
-- Safe to re-run: every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------- extensions
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------- puzzles
create table if not exists public.puzzles (
  id           text primary key
               check (id ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  question     text        not null check (length(question) between 8 and 2000),
  type         text        not null check (type in ('logic', 'math', 'word', 'lateral', 'trivia')),
  difficulty   text        not null check (difficulty in ('easy', 'medium', 'hard')),
  answers      text[]      not null check (cardinality(answers) between 1 and 24),
  match_mode   text        not null default 'exact' check (match_mode in ('exact', 'partial', 'regex')),
  hints        text[]      not null default '{}' check (cardinality(hints) <= 5),
  explanation  text,
  base_points  integer     not null default 100 check (base_points between 0 and 1000),
  is_published boolean     not null default true,
  tags         text[]      not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.puzzles is 'The puzzle catalogue. `answers` and `hints` are secret - never expose them to the anon role.';

-- Serving a random puzzle filters on these three columns, so index them together.
create index if not exists puzzles_published_type_difficulty_idx
  on public.puzzles (is_published, type, difficulty);
create index if not exists puzzles_tags_idx on public.puzzles using gin (tags);

-- ------------------------------------------------------------------- players
create table if not exists public.players (
  username       text primary key check (length(username) between 1 and 32),
  total_score    integer     not null default 0 check (total_score >= 0),
  solves         integer     not null default 0 check (solves >= 0),
  current_streak integer     not null default 0 check (current_streak >= 0),
  best_streak    integer     not null default 0 check (best_streak >= 0),
  last_solved_at timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists players_leaderboard_idx
  on public.players (total_score desc, username asc);

-- ------------------------------------------------------------------ attempts
-- One row per graded submission. Correct and wrong both land here, which makes
-- every statistic on the site a plain aggregate rather than a hand-kept counter.
create table if not exists public.attempts (
  id             bigint generated always as identity primary key,
  puzzle_id      text references public.puzzles (id) on delete set null,
  username       text,
  is_correct     boolean     not null,
  points_earned  integer     not null default 0 check (points_earned >= 0),
  hints_used     integer     not null default 0 check (hints_used >= 0),
  wrong_attempts integer     not null default 0 check (wrong_attempts >= 0),
  duration_ms    integer     check (duration_ms is null or duration_ms >= 0),
  created_at     timestamptz not null default now()
);

create index if not exists attempts_puzzle_idx  on public.attempts (puzzle_id);
create index if not exists attempts_correct_idx on public.attempts (is_correct);
create index if not exists attempts_created_idx on public.attempts (created_at desc);

-- --------------------------------------------------------- updated_at trigger
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists puzzles_touch_updated_at on public.puzzles;
create trigger puzzles_touch_updated_at
  before update on public.puzzles
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------- atomic solve recording
-- Score accumulation must not be read-modify-write from the app, or two solves
-- landing together would lose one. This does it in a single statement.
create or replace function public.record_solve(
  p_username text,
  p_points   integer,
  p_streak   integer default null
)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.players;
begin
  insert into public.players as pl (username, total_score, solves, current_streak, best_streak, last_solved_at)
  values (p_username, greatest(p_points, 0), 1, coalesce(p_streak, 1), coalesce(p_streak, 1), now())
  on conflict (username) do update
    set total_score    = pl.total_score + greatest(p_points, 0),
        solves         = pl.solves + 1,
        current_streak = coalesce(p_streak, pl.current_streak + 1),
        best_streak    = greatest(pl.best_streak, coalesce(p_streak, pl.current_streak + 1)),
        last_solved_at = now()
  returning * into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------- views
-- Read models for the charts. Aggregating in Postgres keeps the app from pulling
-- the whole attempts table across the wire just to draw three bars.

create or replace view public.v_solves_by_type as
  select p.type, count(*)::bigint as solves
  from public.attempts a
  join public.puzzles p on p.id = a.puzzle_id
  where a.is_correct
  group by p.type;

create or replace view public.v_solves_by_difficulty as
  select p.difficulty, count(*)::bigint as solves
  from public.attempts a
  join public.puzzles p on p.id = a.puzzle_id
  where a.is_correct
  group by p.difficulty;

create or replace view public.v_stats_summary as
  select
    (select count(*) from public.attempts)                          ::bigint as total_attempts,
    (select count(*) from public.attempts where is_correct)          ::bigint as total_solves,
    (select count(*) from public.attempts where is_correct)          ::bigint as correct_count,
    (select count(*) from public.attempts where not is_correct)      ::bigint as wrong_count,
    (select coalesce(sum(points_earned), 0) from public.attempts)    ::bigint as total_points,
    (select count(*) from public.players)                            ::bigint as player_count,
    (select count(*) from public.puzzles where is_published)         ::bigint as puzzle_count;

-- A puzzle view with the secrets stripped, safe for the anon role to read directly.
create or replace view public.v_puzzles_public as
  select id, question, type, difficulty, base_points, match_mode, tags,
         cardinality(hints) as hint_count, created_at
  from public.puzzles
  where is_published;

-- ------------------------------------------------------------------------ RLS
-- The server talks to Postgres with the service-role key, which bypasses RLS.
-- These policies exist so that if the anon key is ever used (or a key leaks),
-- the worst case is reading public data - never reading answers or writing rows.

alter table public.puzzles  enable row level security;
alter table public.players  enable row level security;
alter table public.attempts enable row level security;

drop policy if exists "puzzles are readable by everyone" on public.puzzles;
create policy "puzzles are readable by everyone"
  on public.puzzles for select
  using (is_published);

drop policy if exists "leaderboard is readable by everyone" on public.players;
create policy "leaderboard is readable by everyone"
  on public.players for select
  using (true);

-- No insert/update/delete policies anywhere: writes require the service role.

grant select on public.v_puzzles_public to anon, authenticated;
grant select on public.v_stats_summary, public.v_solves_by_type, public.v_solves_by_difficulty
  to anon, authenticated;
