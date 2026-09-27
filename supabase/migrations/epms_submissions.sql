-- Schema for the standalone EPMS Supabase project
create table if not exists public.epms_submissions (
  id uuid primary key default gen_random_uuid(),
  edit_token uuid not null unique default gen_random_uuid(),
  tx_ref text not null unique default ('UCHEPMS25-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 24)),
  year int not null default 2025,
  surname text, first_name text, ippis text, phone text, email text, unit text,
  data jsonb not null default '{}'::jsonb,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','failed')),
  amount_paid numeric, currency text, flw_transaction_id text, paid_at timestamptz,
  filled_at timestamptz, fill_notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.epms_submissions enable row level security;  -- no policies: only the edge function (service role) can read/write
revoke all on public.epms_submissions from anon, authenticated;
