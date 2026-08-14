-- Message read receipts and manual milestone responsibility.
-- Safe to run repeatedly in the Supabase SQL Editor.

alter table public.nl_comments
  add column if not exists read_at timestamptz,
  add column if not exists read_by_name text;

-- Earlier versions used role names as automatic owners. Responsibility is now
-- explicitly assigned by brand users in the milestone maintenance page.
update public.nl_milestones
set owner_name = null
where owner_name in ('品牌方', '工厂');
