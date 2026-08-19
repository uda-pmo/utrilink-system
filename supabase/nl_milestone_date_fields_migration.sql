-- Replace the ambiguous milestone date pair with explicit business dates.
-- Legacy columns are retained for rollback compatibility; application code no
-- longer reads or writes them after this migration.
alter table public.nl_milestones
  add column if not exists brand_required_date date,
  add column if not exists factory_plan_date date,
  add column if not exists actual_finish_date timestamptz;

-- Preserve existing data: old planned dates are factory plans and old actual
-- dates are completion dates. Brand requirements start empty for later entry.
update public.nl_milestones
set factory_plan_date = plan_date
where factory_plan_date is null and plan_date is not null;

update public.nl_milestones
set actual_finish_date = actual_date::timestamptz
where actual_finish_date is null and actual_date is not null;

comment on column public.nl_milestones.brand_required_date is '品牌方要求完成日期';
comment on column public.nl_milestones.factory_plan_date is '工厂计划完成日期';
comment on column public.nl_milestones.actual_finish_date is '实际完成日期';
