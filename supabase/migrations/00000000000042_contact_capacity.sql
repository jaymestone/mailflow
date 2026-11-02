alter table contacts add column if not exists capacity integer;
create index if not exists contacts_capacity_idx on contacts (capacity);
