-- Publishing disclosures (TASK-017), and two rules owed on older tables.
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-22:
--   * A stale publish is refused. A publish names
--     the version it was based on; if a newer one exists, it is refused
--     with the fixed hint `disclosure_changed`, as TASK-010 refuses a stale
--     edit of an AI system. The check and the insert run under TASK-016's
--     per-system lock, in publish_disclosure() below, so two people can't
--     both pass it.
--   * A publish identical to the current version is refused, with the hint
--     `disclosure_unchanged`: every version is permanent evidence, so a new
--     one should mean something changed. It is checked in the table's own
--     trigger, so it holds for every writer.
--   * AI systems refuse deletes (PR #31 review, note 1), the service role
--     included, unless their organization is being deleted. Deleting an AI
--     system would otherwise cascade through its disclosure versions and
--     deployments in one statement; now only deleting the whole
--     organization, the data-erasure path, removes that history.
--   * The NFC check owed since the PR #23 review (TASK-009): AI system
--     names, providers and descriptions, and organization names, must be in
--     Unicode's composed form, as the application has stored them since
--     then. The constraints are validated here, against existing rows: if
--     one isn't NFC, this migration fails before changing anything, rather
--     than rewriting a name without an audit event.

-- AI systems are archived, not deleted ------------------------------------------

-- By the time an organization's delete cascades to this row, the
-- organization is gone, so that path still works; nothing else does, short
-- of the table owner disabling the trigger. Users have no delete grant
-- (TASK-008) either.
create function private.refuse_ai_system_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations where id = old.organization_id) then
    raise exception 'AI systems are archived, not deleted'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke all on function private.refuse_ai_system_delete()
  from public, anon, authenticated;

create trigger ai_systems_refuse_delete
  before delete on public.ai_systems
  for each row execute function private.refuse_ai_system_delete();

-- A truncate would skip the row trigger above.
create function private.refuse_ai_system_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AI systems are archived, not deleted'
    using errcode = '42501';
end;
$$;

revoke all on function private.refuse_ai_system_truncate()
  from public, anon, authenticated;

create trigger ai_systems_refuse_truncate
  before truncate on public.ai_systems
  for each statement execute function private.refuse_ai_system_truncate();

-- NFC (PR #23 review, finding 2; owner, 2026-09-21) --------------------------------

-- `is nfc normalized` is null for a null value, so an absent provider or
-- description passes.
alter table public.organizations
  add constraint organizations_name_nfc_check check (name is nfc normalized);

alter table public.ai_systems
  add constraint ai_systems_name_nfc_check check (name is nfc normalized),
  add constraint ai_systems_provider_nfc_check check (provider is nfc normalized),
  add constraint ai_systems_description_nfc_check check (description is nfc normalized);

-- An unchanged publish is refused -------------------------------------------------

-- TASK-016's trigger, as it was, plus one check after the version is
-- counted: a new version identical to the current one (same message,
-- language and on or off) is refused. It runs under the same lock, so it
-- compares against the version this one would follow.
create or replace function private.set_disclosure_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'disclosures are published by a signed-in user'
      using errcode = '42501';
  end if;

  perform
  from public.ai_systems
  where organization_id = new.organization_id
    and id = new.ai_system_id;

  if not found then
    raise exception 'a disclosure''s AI system is not in its organization'
      using errcode = '23503', constraint = 'disclosures_ai_system_fkey';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public.disclosures:' || new.ai_system_id::text, 0)
  );

  new.version := coalesce(
    (
      select max(version)
      from public.disclosures
      where ai_system_id = new.ai_system_id
    ),
    0
  ) + 1;

  -- PostgREST answers a `PTxyz` code with HTTP status xyz; the service
  -- matches the code and the fixed hint, never the message.
  if exists (
    select 1
    from public.disclosures
    where ai_system_id = new.ai_system_id
      and version = new.version - 1
      and message = new.message
      and language = new.language
      and enabled = new.enabled
  ) then
    raise exception 'the disclosure is unchanged'
      using errcode = 'PT409', hint = 'disclosure_unchanged';
  end if;

  new.created_by := v_actor;
  new.created_at := now();
  return new;
end;
$$;

-- Publishing, with a stale-publish check ---------------------------------------------

-- Publishes a version, if the system's current version is still
-- `p_expected_version` (null: it has none yet). Runs as the caller, so RLS
-- and TASK-016's triggers apply to the insert exactly as to a direct one.
--
-- The visibility check comes first, as in the trigger, so the lock and the
-- read below never touch a system the caller can't see, and a stranger gets
-- the same `23503` whatever that system has. Past it, the caller can read
-- every version of the system, so the count is right. The lock is TASK-016's
-- (the trigger takes it again, which is harmless within one transaction), so
-- the check and the insert can't be split by another publish.
--
-- A direct insert, which the Data API still allows, skips only this check:
-- it is there so a person doesn't unknowingly replace a colleague's newer
-- text, and history keeps every version either way.
create function public.publish_disclosure(
  p_organization_id uuid,
  p_ai_system_id uuid,
  p_message text,
  p_language text,
  p_enabled boolean,
  p_expected_version integer
)
returns public.disclosures
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_current integer;
  v_row public.disclosures;
begin
  perform
  from public.ai_systems
  where organization_id = p_organization_id
    and id = p_ai_system_id;

  if not found then
    raise exception 'a disclosure''s AI system is not in its organization'
      using errcode = '23503', constraint = 'disclosures_ai_system_fkey';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('public.disclosures:' || p_ai_system_id::text, 0)
  );

  select max(version)
  into v_current
  from public.disclosures
  where ai_system_id = p_ai_system_id;

  if v_current is distinct from p_expected_version then
    raise exception 'the disclosure has a newer version'
      using errcode = 'PT409', hint = 'disclosure_changed';
  end if;

  insert into public.disclosures
    (organization_id, ai_system_id, message, language, enabled)
  values
    (p_organization_id, p_ai_system_id, p_message, p_language, p_enabled)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.publish_disclosure(uuid, uuid, text, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.publish_disclosure(uuid, uuid, text, text, boolean, integer)
  to authenticated;

comment on function public.publish_disclosure(uuid, uuid, text, text, boolean, integer) is
  'Publishes a disclosure version if the current one is still p_expected_version (TASK-017).';
