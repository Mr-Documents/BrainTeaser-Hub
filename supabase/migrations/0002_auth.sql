-- ============================================================================
-- Brain Teaser Hub - optional player accounts
--
-- Moves the leaderboard from a free-text display name to a real identity backed
-- by auth.users, without gating play: anonymous solves still count toward the
-- global statistics, they just do not create a player row or a ranked score.
--
-- Apply after 0001_init.sql. Safe to re-run.
-- ============================================================================

-- ------------------------------------------------- drop dependents up front
-- Postgres refuses to drop a table while anything still depends on it, so every
-- object that 0001 built on top of the old `players` table has to go first:
--   - record_solve(text, ...)  returns the old players row type
--   - v_stats_summary          counts from the old players table
-- Both are recreated further down against the new shape. Doing this before the
-- table is touched keeps the script re-runnable and avoids needing CASCADE,
-- which would silently drop whatever else happened to be attached.

drop function if exists public.record_solve(text, integer, integer);
drop view if exists public.v_stats_summary;
drop view if exists public.v_leaderboard;

-- ------------------------------------------------------------------- players
-- The old table was keyed on the submitted username, which anyone could claim.
-- It is replaced by a table keyed on the authenticated user.
--
-- There is deliberately no data migration: a username-keyed score has no
-- trustworthy owner to carry forward, so the old rows are discarded rather than
-- attributed to whoever happens to sign up with that name first.

drop table if exists public.players_legacy;
alter table if exists public.players rename to players_legacy;

create table if not exists public.players (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  display_name   text        not null check (length(display_name) between 1 and 32),
  email          text,
  total_score    integer     not null default 0 check (total_score >= 0),
  solves         integer     not null default 0 check (solves >= 0),
  current_streak integer     not null default 0 check (current_streak >= 0),
  best_streak    integer     not null default 0 check (best_streak >= 0),
  last_solved_at timestamptz,
  created_at     timestamptz not null default now()
);

comment on table public.players is
  'One row per signed-in player. Anonymous play is never recorded here - only in attempts.';

create index if not exists players_leaderboard_idx
  on public.players (total_score desc, display_name asc);

-- Display names are for humans, so uniqueness is case-insensitive: "Ada" and "ada"
-- must not both appear on the leaderboard.
create unique index if not exists players_display_name_key
  on public.players (lower(display_name));

drop table if exists public.players_legacy;

-- ------------------------------------------------------------------ attempts
-- Attempts move from a username string to a nullable user reference. NULL means
-- the solve was anonymous: it still counts in the global stats, it just has no owner.

alter table public.attempts drop column if exists username;
alter table public.attempts add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists attempts_user_idx on public.attempts (user_id);

-- --------------------------------------------------------- atomic solve recording
-- Replaces the username-keyed version from 0001.

create or replace function public.record_solve(
  p_user_id      uuid,
  p_display_name text,
  p_points       integer,
  p_streak       integer default null
)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.players;
begin
  insert into public.players as pl (user_id, display_name, total_score, solves, current_streak, best_streak, last_solved_at)
  values (
    p_user_id,
    p_display_name,
    greatest(p_points, 0),
    1,
    coalesce(p_streak, 1),
    coalesce(p_streak, 1),
    now()
  )
  on conflict (user_id) do update
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
-- v_stats_summary counted players; rebuild it against the new table.

create or replace view public.v_stats_summary as
  select
    (select count(*) from public.attempts)                       ::bigint as total_attempts,
    (select count(*) from public.attempts where is_correct)       ::bigint as total_solves,
    (select count(*) from public.attempts where is_correct)       ::bigint as correct_count,
    (select count(*) from public.attempts where not is_correct)   ::bigint as wrong_count,
    (select coalesce(sum(points_earned), 0) from public.attempts) ::bigint as total_points,
    (select count(*) from public.players)                         ::bigint as player_count,
    (select count(*) from public.puzzles where is_published)      ::bigint as puzzle_count;

-- A leaderboard view that exposes only what is safe to show publicly - notably not the email.
create or replace view public.v_leaderboard as
  select display_name, total_score, solves, current_streak, best_streak, last_solved_at
  from public.players
  order by total_score desc, display_name asc;

-- ------------------------------------------------------------------------ RLS

alter table public.players enable row level security;

drop policy if exists "leaderboard is readable by everyone" on public.players;

-- The public board reads through v_leaderboard, which omits the email. Direct table reads are
-- restricted to the owner so one player cannot enumerate everyone else's address.
drop policy if exists "players can read their own row" on public.players;
create policy "players can read their own row"
  on public.players for select
  using (auth.uid() = user_id);

grant select on public.v_leaderboard to anon, authenticated;
grant select on public.v_stats_summary to anon, authenticated;
