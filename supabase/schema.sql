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
  last_error text,
  created_at timestamptz not null default now(),
  unique(device_id, event_key)
);

create index if not exists idx_notification_events_due
on public.notification_events(status, scheduled_at);

create index if not exists idx_notification_events_device
on public.notification_events(device_id);
