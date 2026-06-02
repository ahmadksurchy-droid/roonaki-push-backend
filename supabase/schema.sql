create extension if not exists pgcrypto;

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  install_id text not null unique,
  expo_push_token text not null,
  platform text,
  timezone text default 'Asia/Baghdad',
  latitude double precision,
  longitude double precision,
  calculation_method text,
  selected_city_id text,
  selected_muezzin_id text default 'adhan',
  notification_prefs jsonb default '{}'::jsonb,
  volume_settings jsonb default '{}'::jsonb,
  time_adjustments jsonb default '{}'::jsonb,
  raw_settings jsonb default '{}'::jsonb,
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  event_key text not null,
  dedupe_key text,
  prayer_key text,
  event_type text,
  title text not null,
  body text not null,
  scheduled_at timestamptz not null,
  sound_key text default 'silent',
  data jsonb default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  sent_at timestamptz,
  expo_ticket_id text,
  processing_started_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id, event_key)
);

-- Safe upgrades for older deployments.
alter table public.notification_events add column if not exists dedupe_key text;
alter table public.notification_events add column if not exists expo_ticket_id text;
alter table public.notification_events add column if not exists processing_started_at timestamptz;
alter table public.notification_events add column if not exists updated_at timestamptz not null default now();

create unique index if not exists uniq_notification_events_dedupe
on public.notification_events(device_id, dedupe_key)
where dedupe_key is not null and status in ('pending', 'processing', 'sent');

create index if not exists idx_notification_events_due
on public.notification_events(status, scheduled_at);

create index if not exists idx_notification_events_device
on public.notification_events(device_id);

create table if not exists public.push_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.notification_events(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  install_id text,
  expo_push_token text,
  prayer_key text,
  event_type text,
  scheduled_at timestamptz,
  expo_ticket_id text,
  ticket_status text,
  receipt_status text,
  error text,
  message jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_delivery_logs_created
on public.push_delivery_logs(created_at desc);

create index if not exists idx_push_delivery_logs_event
on public.push_delivery_logs(event_id);

-- Keep RLS enabled for safety. The backend uses service_role and bypasses RLS.
alter table public.devices enable row level security;
alter table public.notification_events enable row level security;
alter table public.push_delivery_logs enable row level security;
