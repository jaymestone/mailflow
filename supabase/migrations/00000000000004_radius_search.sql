-- Powers "within N miles of X" / "between N and M miles of X" venue queries.
-- Distances are computed in meters (geography type); the app converts
-- miles <-> meters at the boundary.
create or replace function contacts_search_radius(
  center_lat double precision,
  center_lng double precision,
  min_meters double precision default 0,
  max_meters double precision default null,
  list_filter uuid default null,
  result_limit int default 500
) returns setof contacts as $$
  select c.* from contacts c
  where c.geom is not null
    and (max_meters is null or ST_DWithin(c.geom, ST_MakePoint(center_lng, center_lat)::geography, max_meters))
    and (min_meters <= 0 or ST_Distance(c.geom, ST_MakePoint(center_lng, center_lat)::geography) >= min_meters)
    and (list_filter is null or c.list_id = list_filter)
  order by ST_Distance(c.geom, ST_MakePoint(center_lng, center_lat)::geography)
  limit result_limit;
$$ language sql stable;

grant execute on function contacts_search_radius(double precision, double precision, double precision, double precision, uuid, int) to authenticated;
