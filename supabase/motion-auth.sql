-- Review and run in the designated Supabase project, then enable this function
-- as its Custom Access Token hook. This file grants nobody Motion access.
-- Do not overwrite an existing project hook without reviewing its responsibilities.
begin;
create schema if not exists motion_auth;
revoke all on schema motion_auth from public, anon, authenticated;
grant usage on schema motion_auth to supabase_auth_admin;
create table if not exists motion_auth.clients (
  client_id text primary key,
  subject uuid not null,
  resource text not null check (resource like 'https://%/mcp'),
  permissions text[] not null check (
    permissions @> array['motion:read']::text[] and
    permissions <@ array['motion:read', 'motion:write']::text[]
  )
);
alter table motion_auth.clients enable row level security;
revoke all on motion_auth.clients from public, anon, authenticated, supabase_auth_admin;
grant select on motion_auth.clients to supabase_auth_admin;
drop policy if exists auth_reads_motion_clients on motion_auth.clients;
create policy auth_reads_motion_clients on motion_auth.clients
  for select to supabase_auth_admin using (true);
create or replace function motion_auth.access_token_hook(event jsonb)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  claims jsonb := event->'claims';
  registration motion_auth.clients%rowtype;
begin
  -- This top-level grant is server-owned, never copied from user_metadata.
  claims := claims - 'motion_permissions';
  select * into registration from motion_auth.clients
    where client_id = claims->>'client_id';
  if found and claims->>'sub' = registration.subject::text
    and event->>'user_id' = registration.subject::text
    and claims->'is_anonymous' = 'false'::jsonb then
    claims := jsonb_set(claims, '{aud}', to_jsonb(registration.resource));
    claims := jsonb_set(claims, '{motion_permissions}', to_jsonb(registration.permissions));
    -- OAuth refresh re-runs this hook and rechecks the current registration.
    claims := jsonb_set(claims, '{exp}', to_jsonb(least(
      (claims->>'exp')::bigint, (claims->>'iat')::bigint + 900
    )));
  end if;
  return jsonb_build_object('claims', claims);
end;
$$;
revoke all on function motion_auth.access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function motion_auth.access_token_hook(jsonb) to supabase_auth_admin;
commit;
