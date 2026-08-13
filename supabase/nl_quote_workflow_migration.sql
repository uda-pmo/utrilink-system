-- Quote correction traceability and quote-confirmation milestone.
-- Safe to run more than once in Supabase SQL Editor.

alter table public.nl_quotes add column if not exists price_change_reason text;
alter table public.nl_quotes add column if not exists based_on_quote_id bigint references public.nl_quotes(id) on delete set null;
create index if not exists nl_quotes_based_on_quote_idx on public.nl_quotes(based_on_quote_id);

alter table public.nl_notifications alter column order_id drop not null;

-- Add the missing milestone to every existing order and normalize the sequence.
insert into public.nl_milestones (order_id, node_key, node_name, sequence)
select o.id, 'quote_confirmed', '报价确认', 3
from public.nl_orders o
where not exists (
  select 1 from public.nl_milestones m where m.order_id = o.id and m.node_key = 'quote_confirmed'
);

update public.nl_milestones
set sequence = case node_key
  when 'formula_confirmed' then 1
  when 'packaging_confirmed' then 2
  when 'quote_confirmed' then 3
  when 'contract_confirmed' then 4
  when 'raw_material_purchase' then 5
  when 'raw_material_received' then 6
  when 'sampling' then 7
  when 'production' then 8
  when 'semi_finished_test' then 9
  when 'finished_production' then 10
  when 'outer_packaging' then 11
  when 'sample_sent' then 12
  when 'shipment' then 13
  else sequence
end;
