-- Run this once in Supabase → SQL Editor

create table if not exists budget_store (
  key   text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- Auto-update timestamp on every upsert
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger budget_store_updated_at
  before update on budget_store
  for each row execute procedure update_updated_at();

-- Allow anonymous reads and writes (matches your anon key)
alter table budget_store enable row level security;

create policy "anon read"  on budget_store for select using (true);
create policy "anon write" on budget_store for insert with check (true);
create policy "anon update" on budget_store for update using (true);
