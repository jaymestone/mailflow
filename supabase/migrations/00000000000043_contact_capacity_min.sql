alter table contacts add column if not exists capacity_min integer;
create index if not exists contacts_capacity_min_idx on contacts (capacity_min);
