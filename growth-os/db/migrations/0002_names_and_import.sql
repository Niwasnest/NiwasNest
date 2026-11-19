-- Approvals and policies can be decided by the founder before app_users exist: keep a name too.
alter table approvals add column if not exists decided_by_name text;
alter table commercial_policies add column if not exists approved_by_name text;
alter table offers add column if not exists approved_by_name text;

-- Track which migrations ran.
create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now());
alter table schema_migrations enable row level security;
insert into schema_migrations (version) values ('0001_growth_os'), ('0002_names_and_import') on conflict do nothing;
