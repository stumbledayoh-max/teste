-- =============================================================================
--  Sistema de licenças por key
--  Tabelas: licenses · license_devices · license_events
--  Regras: key só como hash, assentos garantidos por trigger, RLS fechado.
--  Aplique com:  supabase db push   (ou cole no SQL Editor do projeto)
-- =============================================================================

-- ------------------------------- licenças -----------------------------------

create table if not exists public.licenses (
  id           uuid primary key default gen_random_uuid(),
  key_hash     text        not null unique,           -- sha256(prefixo:key)
  key_prefix   text        not null,                  -- "ENJOY-AB1"
  key_hint     text        not null,                  -- últimos 4 dígitos
  plan         text        not null default 'pro',
  status       text        not null default 'active' check (status in ('active', 'revoked')),
  max_devices  integer     not null default 1 check (max_devices between 1 and 100),
  expires_at   timestamptz,                           -- null = nunca expira
  email        text,
  note         text,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists licenses_status_idx      on public.licenses (status);
create index if not exists licenses_expires_at_idx  on public.licenses (expires_at);
create index if not exists licenses_created_at_idx  on public.licenses (created_at desc);

-- ------------------------------ dispositivos --------------------------------

create table if not exists public.license_devices (
  license_id  uuid        not null references public.licenses (id) on delete cascade,
  device_id   text        not null,                   -- id estável gerado no cliente
  device_name text,
  platform    text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  revoked     boolean     not null default false,
  primary key (license_id, device_id)
);

create index if not exists license_devices_license_idx on public.license_devices (license_id);
create index if not exists license_devices_seen_idx    on public.license_devices (last_seen desc);

-- -------------------------------- auditoria ---------------------------------

create table if not exists public.license_events (
  id         bigserial primary key,
  license_id uuid references public.licenses (id) on delete cascade,
  device_id  text,
  kind       text not null check (kind in ('activate', 'validate', 'deactivate', 'revoke', 'denied', 'admin')),
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists license_events_created_idx on public.license_events (created_at desc);
create index if not exists license_events_license_idx on public.license_events (license_id);

-- --------------------- limite de assentos no banco --------------------------
-- Sem isso, duas ativações simultâneas poderiam passar pela contagem feita na
-- API e estourar o limite. O trigger rejeita o INSERT com SQLSTATE P0001.

create or replace function public.lic_seat_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  used integer;
  maxd integer;
begin
  select count(*) into used
    from public.license_devices d
   where d.license_id = new.license_id
     and d.revoked = false;

  select l.max_devices into maxd
    from public.licenses l
   where l.id = new.license_id;

  if maxd is null then
    raise exception 'UNKNOWN_LICENSE' using errcode = 'P0001';
  end if;

  if used >= maxd then
    raise exception 'SEAT_LIMIT' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_lic_seat_guard on public.license_devices;
create trigger trg_lic_seat_guard
  before insert on public.license_devices
  for each row execute function public.lic_seat_guard();

-- --------------------------------- RLS --------------------------------------
-- Ligado e SEM policies: anon/authenticated não enxergam nada.
-- A API usa a service_role key no servidor e passa por cima do RLS.

alter table public.licenses        enable row level security;
alter table public.license_devices enable row level security;
alter table public.license_events  enable row level security;

revoke all on public.licenses        from anon, authenticated;
revoke all on public.license_devices from anon, authenticated;
revoke all on public.license_events  from anon, authenticated;
revoke all on sequence public.license_events_id_seq from anon, authenticated;
