-- Run once in the Supabase SQL Editor before deploying document type support.
alter table public.nl_files add column if not exists document_type text not null default 'other';
create index if not exists nl_files_order_document_type_idx on public.nl_files(order_id, document_type);
