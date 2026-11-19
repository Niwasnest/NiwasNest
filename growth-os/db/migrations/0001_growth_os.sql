-- NiwasNest Growth OS — its OWN database (e.g. a separate Supabase project).
-- Nothing here touches the main NiwasNest database. Links to the main app are by id only
-- (niwasnest_property_id / niwasnest_lead_id), synced through the read-only API bridge.

create extension if not exists pgcrypto;

create type lead_status as enum (
  'new_lead','not_contacted','contacted','no_answer','interested','follow_up','demo_requested',
  'onboarding_sent','onboarding_started','details_pending','verification_pending','approved','live',
  'not_interested','do_not_contact','lost');
create type lead_kind as enum ('pg_owner','student','institution','corporate_hr','influencer','partner');
create type channel as enum ('call','whatsapp','sms','email','web_chat','field_visit');

create table app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  role text not null check (role in ('founder','admin','finance','sales','field','viewer')),
  created_at timestamptz not null default now()
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  kind lead_kind not null,
  owner_name text, pg_name text,
  phone_e164 text, email text,
  address text, locality text, city text not null default 'Bengaluru',
  lat double precision, lng double precision,
  property_type text check (property_type in ('male','female','co_living','other')),
  total_beds int, vacant_beds int, rent_min int, rent_max int,
  source text not null, tracking_code text,
  assigned_agent text, assigned_user_id uuid references app_users(id),
  language text not null default 'te' check (language in ('te','en','kn','hi')),
  status lead_status not null default 'new_lead',
  interest_level smallint check (interest_level between 1 and 5),
  last_contact_at timestamptz, next_follow_up_at timestamptz,
  opted_out boolean not null default false,
  niwasnest_property_id text, niwasnest_lead_id text,
  notes text,
  created_at timestamptz not null default now()
);
create unique index leads_phone_unique on leads (phone_e164) where phone_e164 is not null and kind = 'pg_owner';
create index leads_status_idx on leads (status, next_follow_up_at);
create index leads_locality_idx on leads (locality);

create table lead_events (
  id bigserial primary key,
  lead_id uuid not null references leads(id),
  at timestamptz not null default now(),
  actor text not null,
  type text not null,
  from_status lead_status, to_status lead_status,
  detail text
);

create table contact_consents (
  id bigserial primary key,
  phone_e164 text, email text,
  channel channel not null,
  granted boolean not null,
  evidence text not null,
  captured_at timestamptz not null default now()
);
create index consents_lookup on contact_consents (phone_e164, channel, captured_at desc);

create table contact_attempts (
  id bigserial primary key,
  lead_id uuid not null references leads(id),
  channel channel not null,
  at timestamptz not null default now(),
  outcome text,
  provider_ref text
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  provider text not null, provider_call_id text unique,
  direction text not null check (direction in ('inbound','outbound')),
  started_at timestamptz, duration_sec int,
  recording_path text,           -- private storage path, never public
  transcript text, summary text, outcome text, language text
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  channel channel not null,
  external_id text,              -- WhatsApp wa_id / chat session id
  last_inbound_at timestamptz,   -- for the WhatsApp 24h window
  handed_off boolean not null default false
);
create table messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id),
  direction text not null check (direction in ('in','out')),
  body text, template_key text, provider_ref text,
  status text not null default 'queued',
  at timestamptz not null default now()
);
create table wa_templates (
  key text primary key, language text not null, body text not null,
  meta_status text not null default 'draft' -- draft | submitted | approved | rejected
);

create table commercial_policies (
  id uuid primary key default gen_random_uuid(),
  niwasnest_property_id text,    -- null = default policy
  type text not null check (type in ('first_month_commission','listing_fee','service_charge')),
  percent numeric(5,2), flat_inr int,
  applies_to_months text not null check (applies_to_months in ('first_month_only','every_month')),
  approved_wording text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','retired')),
  is_historical boolean not null default false,
  approved_by uuid references app_users(id), approved_at timestamptz,
  effective_from timestamptz not null, effective_to timestamptz,
  check ((percent is null) <> (flat_inr is null))
);

create table offers (
  id uuid primary key default gen_random_uuid(),
  name text not null, audience text not null,
  starts_at timestamptz not null, ends_at timestamptz not null,
  eligibility text not null, reward text not null,
  budget_inr int not null, max_redemptions int not null, redemptions int not null default 0,
  tracking_code text not null unique, terms text not null,
  status text not null default 'draft', approved_by uuid references app_users(id)
);

create table referral_rule_sets (
  version text primary key, approved boolean not null default false,
  booking_referral_inr int not null, owner_referral_per_booking_inr int not null,
  owner_referral_max_bookings int not null, owner_referral_cap_inr int not null,
  min_days_after_check_in int not null default 7,
  approved_by uuid references app_users(id)
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null, audience text not null, kind text not null,  -- tea_shop, lift, tent, college, digital…
  starts_at date, ends_at date, budget_inr int,
  target_live_pgs int, target_bookings int,
  status text not null default 'draft', approved_by uuid references app_users(id)
);
create table tracking_codes (
  code text primary key,                 -- printed on the QR / sticker
  campaign_id uuid references campaigns(id),
  placement text,                        -- e.g. "Chai Point, 2nd Main, BTM"
  destination_url text not null,         -- must be a niwasnest.com URL
  locality text, created_at timestamptz not null default now()
);
create table qr_scans (id bigserial primary key, code text not null references tracking_codes(code), at timestamptz not null default now(), ua_hash text);
create table expenses (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id), tracking_code text references tracking_codes(code),
  amount_inr int not null, description text not null, incurred_on date not null,
  approved_by uuid references app_users(id)
);

create table institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null, type text not null, locality text, city text not null default 'Bengaluru',
  website text, public_email text, department text, nearby_localities text[],
  stage text not null default 'prospect', notes text
);
create table influencers (
  id uuid primary key default gen_random_uuid(),
  handle text not null, platform text not null, followers int, niche text, locality text,
  public_business_contact text, fit_score smallint, stage text not null default 'prospect',
  referral_code text unique
);
create table emails (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid references institutions(id), influencer_id uuid references influencers(id),
  to_address text not null, subject text not null, body text not null,
  status text not null default 'draft',  -- draft | pending_approval | sent | replied | bounced | unsubscribed
  provider_ref text, sent_at timestamptz
);
create table field_visits (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id), user_id uuid references app_users(id),
  planned_for date, visited_at timestamptz, outcome text, photos_collected int default 0,
  consent_captured boolean default false
);
create table creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id), kind text not null, language text not null,
  tracking_code text references tracking_codes(code), file_url text, status text not null default 'draft'
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_key text not null, action text not null, approver_role text not null,
  summary text not null, payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references app_users(id), decided_at timestamptz
);
create table agent_actions (
  id bigserial primary key,
  at timestamptz not null default now(),
  agent_key text not null, action text not null, input jsonb,
  result text not null check (result in ('done','dry_run','blocked','pending_approval','failed')),
  detail text, provider_ref text
);
create table agent_flags (agent_key text primary key, paused boolean not null default false, updated_by uuid references app_users(id), updated_at timestamptz default now());
insert into agent_flags (agent_key, paused) values ('*', false);  -- '*' = global kill switch

-- Audit tables are append-only.
create or replace function forbid_change() returns trigger language plpgsql as $$
begin raise exception 'append-only table'; end $$;
create trigger agent_actions_append_only before update or delete on agent_actions for each row execute function forbid_change();
create trigger lead_events_append_only before update or delete on lead_events for each row execute function forbid_change();

-- Supabase exposes `public` over its REST API. Enable RLS with no policies on every table so the
-- public (anon) key can read nothing; only the Growth OS server (service role) has access.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
