insert into lists (name) values
  ('Master Presenters US'),
  ('Festivals US'),
  ('Presenters Canada'),
  ('Festivals Canada'),
  ('JCCs'),
  ('Worldwide'),
  ('Classical'),
  ('Jewish Studies'),
  ('Small Venues'),
  ('US Celtic Festivals')
on conflict (name) do nothing;
