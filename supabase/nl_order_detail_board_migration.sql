-- Order-detail board: explicit milestone responsibility.
-- Safe to run more than once in Supabase SQL Editor.

alter table public.nl_milestones
  add column if not exists owner_name text;

update public.nl_milestones
set owner_name = case
  when node_key in ('formula_confirmed', 'quote_confirmed', 'contract_confirmed') then '品牌方'
  else '工厂'
end
where owner_name is null or btrim(owner_name) = '';
