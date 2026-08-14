-- Wraps Supabase Vault so the app can store/read/delete OAuth refresh
-- tokens without the `vault` schema needing to be exposed over PostgREST.
-- Only the service role should ever call these (backend OAuth routes and
-- the send/reply-poll background jobs), never the browser.

create or replace function store_oauth_refresh_token(p_account_id uuid, p_token text)
returns uuid
security definer
set search_path = vault, public
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'oauth_refresh_token_' || p_account_id::text;
begin
  select id into v_secret_id from vault.secrets where name = v_secret_name;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_token, v_secret_name);
  else
    perform vault.update_secret(v_secret_id, p_token);
  end if;

  update connected_accounts set oauth_refresh_token_id = v_secret_id where id = p_account_id;
  return v_secret_id;
end;
$$ language plpgsql;

create or replace function get_oauth_refresh_token(p_account_id uuid)
returns text
security definer
set search_path = vault, public
as $$
  select decrypted_secret from vault.decrypted_secrets
  where id = (select oauth_refresh_token_id from connected_accounts where id = p_account_id);
$$ language sql;

revoke all on function store_oauth_refresh_token(uuid, text) from public, anon, authenticated;
revoke all on function get_oauth_refresh_token(uuid) from public, anon, authenticated;
grant execute on function store_oauth_refresh_token(uuid, text) to service_role;
grant execute on function get_oauth_refresh_token(uuid) to service_role;
