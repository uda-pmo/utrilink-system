-- NutriLink production database. Run once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create type public.app_role as enum ('pmo', 'factory');

create table public.factories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  country text,
  primary_contact_name text,
  primary_contact_email text,
  pmo_owner_name text,
  pmo_owner_email text,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role public.app_role not null default 'factory',
  factory_id uuid references public.factories(id),
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  factory_id uuid not null references public.factories(id),
  product_sku text not null,
  formula text,
  formula_version text,
  production_quantity text,
  packaging_spec text,
  required_delivery date,
  current_node text not null default '等待工厂确认',
  progress smallint not null default 5 check (progress between 0 and 100),
  status text not null default '待确认',
  production_date date,
  shelf_life text,
  expiry_date date,
  sample_sent_at date,
  sample_tracking_no text,
  sample_note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_updates (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  node text not null,
  reported_at date not null default current_date,
  note text,
  submitted_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  document_type text not null,
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_pmo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'pmo');
$$;
create or replace function public.my_factory_id()
returns uuid language sql stable security definer set search_path = public as $$
  select factory_id from public.profiles where id = auth.uid();
$$;
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger orders_touch_updated_at before update on public.orders
for each row execute procedure public.touch_updated_at();

alter table public.factories enable row level security;
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_updates enable row level security;
alter table public.order_documents enable row level security;

create policy "pmo manages factories" on public.factories for all using (public.is_pmo()) with check (public.is_pmo());
create policy "factory reads own factory" on public.factories for select using (id = public.my_factory_id());
create policy "users read own profile" on public.profiles for select using (id = auth.uid() or public.is_pmo());
create policy "pmo manages profiles" on public.profiles for all using (public.is_pmo()) with check (public.is_pmo());
create policy "pmo manages orders" on public.orders for all using (public.is_pmo()) with check (public.is_pmo());
create policy "factory reads assigned orders" on public.orders for select using (factory_id = public.my_factory_id());
create policy "pmo manages order updates" on public.order_updates for all using (public.is_pmo()) with check (public.is_pmo());
create policy "factory creates updates for assigned orders" on public.order_updates for insert with check (
  submitted_by = auth.uid() and exists (select 1 from public.orders o where o.id = order_id and o.factory_id = public.my_factory_id())
);
create policy "factory reads assigned updates" on public.order_updates for select using (
  exists (select 1 from public.orders o where o.id = order_id and o.factory_id = public.my_factory_id())
);
create policy "pmo manages documents" on public.order_documents for all using (public.is_pmo()) with check (public.is_pmo());
create policy "factory reads assigned documents" on public.order_documents for select using (
  exists (select 1 from public.orders o where o.id = order_id and o.factory_id = public.my_factory_id())
);
create policy "factory adds assigned documents" on public.order_documents for insert with check (
  uploaded_by = auth.uid() and exists (select 1 from public.orders o where o.id = order_id and o.factory_id = public.my_factory_id())
);

insert into storage.buckets (id, name, public) values ('order-files', 'order-files', false)
on conflict (id) do nothing;
create policy "authorized users read permitted files" on storage.objects for select using (
  bucket_id = 'order-files' and (public.is_pmo() or exists (
    select 1 from public.orders o where o.id::text = (storage.foldername(name))[1] and o.factory_id = public.my_factory_id()
  ))
);
create policy "authorized users upload permitted files" on storage.objects for insert with check (
  bucket_id = 'order-files' and (public.is_pmo() or exists (
    select 1 from public.orders o where o.id::text = (storage.foldername(name))[1] and o.factory_id = public.my_factory_id()
  ))
);

-- After registering the first PMO user, run this one line with the real email address:
-- update public.profiles set role = 'pmo' where email = 'YOUR-PMO-EMAIL@example.com';
