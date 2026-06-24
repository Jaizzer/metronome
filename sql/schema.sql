-- ============================================================
-- Metronome app schema for Neon Data API
-- Run this once in the Neon SQL Editor (Console > SQL Editor)
-- ============================================================
-- 1. Table: one row per practice routine (the JSON `metronomes` array
--    lives as JSONB so we don't need a third join table)
create table if not exists practices (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null default auth.user_id(),
    name text not null default 'New Routine',
    loop boolean not null default false,
    metronomes jsonb not null default '[]'::jsonb,
    position integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- 2. Table: mastery success/fail counters (one row per user)
create table if not exists mastery_counts (
    owner_id uuid primary key default auth.user_id(),
    success integer not null default 0,
    fail integer not null default 0,
    updated_at timestamptz not null default now()
);
-- 3. Table: small per-user settings (show stats toggle, volume)
create table if not exists user_settings (
    owner_id uuid primary key default auth.user_id(),
    show_stats boolean not null default true,
    volume numeric not null default 0.8,
    updated_at timestamptz not null default now()
);
-- ============================================================
-- Row-Level Security: every user can only ever see/edit their own rows.
-- This is what makes it safe to call these tables directly from the
-- browser with the Data API.
-- ============================================================
alter table practices enable row level security;
alter table mastery_counts enable row level security;
alter table user_settings enable row level security;
create policy "practices_owner_all" on practices for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
create policy "mastery_owner_all" on mastery_counts for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
create policy "settings_owner_all" on user_settings for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
-- ============================================================
-- Keep updated_at fresh automatically
-- ============================================================
create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now();
return new;
end;
$$ language plpgsql;
create trigger practices_set_updated_at before
update on practices for each row execute function set_updated_at();
create trigger mastery_set_updated_at before
update on mastery_counts for each row execute function set_updated_at();
create trigger settings_set_updated_at before
update on user_settings for each row execute function set_updated_at();