-- Keeps contacts.lat/lng/geocode_status in sync with the shared geo_locations
-- cache, in both directions, so the geocode-tick job (or a manual override)
-- only ever has to touch geo_locations.

-- On insert: register the (city, state, country) in the cache if new, and
-- if that location is already resolved, copy coordinates straight onto the
-- new contact instead of leaving it pending until the next tick.
create or replace function contacts_before_insert_sync_geo() returns trigger as $$
declare
  cached geo_locations%rowtype;
begin
  if new.city is null or btrim(new.city) = '' then
    new.geocode_status := 'no_match';
    return new;
  end if;

  insert into geo_locations (city, state, country)
  values (new.city, new.state, new.country)
  on conflict (lower(city), lower(coalesce(state, '')), lower(coalesce(country, '')))
  do nothing;

  select * into cached from geo_locations
  where lower(city) = lower(new.city)
    and lower(coalesce(state, '')) = lower(coalesce(new.state, ''))
    and lower(coalesce(country, '')) = lower(coalesce(new.country, ''));

  if cached.status = 'success' then
    new.lat := cached.lat;
    new.lng := cached.lng;
    new.geocode_status := 'success';
    new.geocoded_at := cached.resolved_at;
  elsif cached.status in ('failed', 'no_match') then
    new.geocode_status := cached.status;
  end if;

  return new;
end;
$$ language plpgsql;

create trigger contacts_before_insert_sync_geo_trigger
  before insert on contacts
  for each row execute function contacts_before_insert_sync_geo();

-- When a geo_location resolves (or is manually overridden), push the result
-- out to every contact sharing that (city, state, country).
create or replace function geo_locations_after_update_sync_contacts() returns trigger as $$
begin
  if new.status is distinct from old.status or new.lat is distinct from old.lat or new.lng is distinct from old.lng then
    update contacts
    set lat = new.lat,
        lng = new.lng,
        geocode_status = new.status,
        geocode_attempts = new.attempts,
        geocoded_at = new.resolved_at
    where lower(city) = lower(new.city)
      and lower(coalesce(state, '')) = lower(coalesce(new.state, ''))
      and lower(coalesce(country, '')) = lower(coalesce(new.country, ''));
  end if;
  return new;
end;
$$ language plpgsql;

create trigger geo_locations_after_update_sync_contacts_trigger
  after update on geo_locations
  for each row execute function geo_locations_after_update_sync_contacts();
