-- ============================================================
-- Metronome app schema for Neon Data API
-- Safe to run multiple times against the same database — every
-- statement is idempotent (create-if-not-exists or drop-then-create).
-- ============================================================
-- 1. Table: one row per practice routine (the JSON `metronomes` array
--    lives as JSONB so we don't need a third join table)
-- NOTE: owner_id is `text`, not `uuid` — auth.user_id() returns text.
-- (Every official Neon RLS example types this column as text; see
-- neon.com/docs/guides/row-level-security.)
create table if not exists practices (
    id uuid primary key default gen_random_uuid(),
    owner_id text not null default auth.user_id(),
    name text not null default 'New Routine',
    loop boolean not null default false,
    metronomes jsonb not null default '[]'::jsonb,
    position integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- If practices was created by an earlier version of this script with
-- owner_id as uuid, fix it in place. Harmless no-op if it's already text.
do $$ begin if exists (
    select 1
    from information_schema.columns
    where table_name = 'practices'
        and column_name = 'owner_id'
        and data_type = 'uuid'
) then
alter table practices
alter column owner_id type text using owner_id::text;
alter table practices
alter column owner_id
set default auth.user_id();
end if;
end $$;
-- 2. Table: mastery success/fail counters (one row per user)
create table if not exists mastery_counts (
    owner_id text primary key default auth.user_id(),
    success integer not null default 0,
    fail integer not null default 0,
    updated_at timestamptz not null default now()
);
-- 3. Table: small per-user settings (show stats toggle, volume)
create table if not exists user_settings (
    owner_id text primary key default auth.user_id(),
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
drop policy if exists "practices_owner_all" on practices;
create policy "practices_owner_all" on practices for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
drop policy if exists "mastery_owner_all" on mastery_counts;
create policy "mastery_owner_all" on mastery_counts for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
drop policy if exists "settings_owner_all" on user_settings;
create policy "settings_owner_all" on user_settings for all using (owner_id = auth.user_id()) with check (owner_id = auth.user_id());
-- ============================================================
-- Grants: RLS controls which ROWS a role can touch, but Postgres
-- separately requires the role to have basic table-level privileges
-- at all. The Neon Data API connects as the `authenticated` role, so
-- without this, every read/write fails with "permission denied for
-- table ..." even though RLS policies are correctly in place.
-- (Source: Neon Data API troubleshooting docs.)
-- The ALTER DEFAULT PRIVILEGES line makes this automatic for any
-- table created in the future too.
-- ============================================================
grant select,
    insert,
    update,
    delete on all tables in schema public to authenticated;
alter default privileges in schema public
grant select,
    insert,
    update,
    delete on tables to authenticated;
-- ============================================================
-- Keep updated_at fresh automatically
-- ============================================================
create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now();
return new;
end;
$$ language plpgsql;
drop trigger if exists practices_set_updated_at on practices;
create trigger practices_set_updated_at before
update on practices for each row execute function set_updated_at();
drop trigger if exists mastery_set_updated_at on mastery_counts;
create trigger mastery_set_updated_at before
update on mastery_counts for each row execute function set_updated_at();
drop trigger if exists settings_set_updated_at on user_settings;
create trigger settings_set_updated_at before
update on user_settings for each row execute function set_updated_at();