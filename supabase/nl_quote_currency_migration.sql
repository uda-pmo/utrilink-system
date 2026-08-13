-- NutriLink temporary quote currency normalization and audit fields.
-- Safe to re-run. It deliberately does not create or query an exchange-rate table.
-- Temporary baseline: 2026-08-13, USD/CNY 7.1800, KRW/CNY 0.00518.

alter table public.nl_quotes add column if not exists cny_unit_price numeric(14,4);
alter table public.nl_quotes add column if not exists fx_rate_to_cny numeric(18,8);
alter table public.nl_quotes add column if not exists fx_rate_date date;
alter table public.nl_quotes add column if not exists fx_provider text;
alter table public.nl_quotes add column if not exists source_kind text not null default 'manual';
alter table public.nl_quotes add column if not exists submitted_by_name text;
alter table public.nl_quotes add column if not exists submitted_at timestamptz;

update public.nl_quotes
set source_kind = case when import_id is not null then 'import' else 'manual' end
where source_kind is null or source_kind = 'manual';

update public.nl_quotes
set submitted_by_name = coalesce(submitted_by_name, created_by_name),
    submitted_at = coalesce(submitted_at, created_at),
    fx_rate_to_cny = case upper(coalesce(currency, 'CNY'))
      when 'CNY' then 1
      when 'USD' then 7.1800
      when 'KRW' then 0.00518
      else fx_rate_to_cny
    end,
    fx_rate_date = case when upper(coalesce(currency, 'CNY')) in ('CNY', 'USD', 'KRW') then date '2026-08-13' else fx_rate_date end,
    fx_provider = case when upper(coalesce(currency, 'CNY')) in ('CNY', 'USD', 'KRW') then 'temporary-fixed-2026-08-13' else fx_provider end,
    cny_unit_price = case upper(coalesce(currency, 'CNY'))
      when 'CNY' then unit_price
      when 'USD' then round(unit_price * 7.1800, 4)
      when 'KRW' then round(unit_price * 0.00518, 4)
      else cny_unit_price
    end;

create index if not exists nl_quotes_cny_price_idx
  on public.nl_quotes(product_name, factory_name, quoted_at, cny_unit_price);
