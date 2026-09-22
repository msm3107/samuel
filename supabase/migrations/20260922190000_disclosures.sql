-- Disclosures (TASK-016): the notice an AI system's widget shows, as a
-- history of published versions (README §5, PLAN Phase 5).
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-22:
--   * A disclosure is written in one of the 24 official EU languages
--     (PLAN open question 4). Article 50 is EU law, and a notice must be in
--     a language its reader understands. Adding a language later is one
--     migration; removing one customers publish in would not be.
--   * Saving publishes. Every row is a published version, and no one updates
--     a row, the service role included. Rejected: drafts that freeze on
--     publishing, a state machine where one mistake unfreezes history.
--   * One current language per AI system: each system has one version
--     history, and its current version is the highest. Rejected for now: a
--     history per language, which Phase 6 and the verifier would each have
--     to choose between.
--   * Turning a disclosure off is a new version with `enabled = false`, so
--     when the notice was on or off is part of the same immutable history.
--     Rejected: an editable switch on a parent row, whose history would live
--     only in the audit log.
--
-- Proposed by the implementer (TASK-016 contract), awaiting the owner:
--   * The database numbers versions 1, 2, 3… per AI system; no writer
--     chooses one.
--   * A message is 1 to 500 characters of plain text on one line: no control
--     characters (line breaks included), no format characters but U+200D,
--     no leading or trailing space, and NFC-normalized.
--   * Nothing is published under an archived AI system, as for deployments.
--   * No one deletes a version, except by deleting its organization or AI
--     system: verification checks (Phase 7) will cite them.
--   * Each version is audited as `disclosure.published`, with no metadata,
--     so customer text stays out of the audit log.
--   * A system the caller can't see is refused as if it didn't exist,
--     before the version is counted (set_disclosure_version, below).

create table public.disclosures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  ai_system_id uuid not null,
  -- Set by the database (below): 1 for a system's first version, then one
  -- more than its highest.
  version integer not null
    constraint disclosures_version_check check (version >= 1),
  -- Plain text, never rendered as HTML or markdown (PLAN Phase 5). The
  -- format-character pattern is the one on ai_systems' and organizations'
  -- names: Unicode general category Cf, less U+200D, as of Unicode 16.0.
  message text not null
    constraint disclosures_message_check check (
      char_length(message) between 1 and 500
      and message = btrim(message)
      and message !~ '[[:cntrl:]]'
      and message !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
      and message is nfc normalized
    ),
  -- ISO 639-1 codes of the 24 official EU languages (owner, 2026-09-22).
  -- features/disclosures/languages.ts mirrors the list, and a test keeps the
  -- two in step.
  language text not null
    constraint disclosures_language_check check (
      language in (
        'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'ga',
        'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk',
        'sl', 'sv'
      )
    ),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- The signed-in user who published it. No foreign key, as for
  -- audit_events' actor: the history must outlive the user.
  created_by uuid not null,
  -- The system is in the same organization as the disclosure.
  constraint disclosures_ai_system_fkey
    foreign key (organization_id, ai_system_id)
    references public.ai_systems (organization_id, id) on delete cascade,
  -- One row per version of a system's disclosure; also the index for "the
  -- current version" (the highest).
  constraint disclosures_ai_system_id_version_key unique (ai_system_id, version),
  -- The target of verification_checks' composite foreign key (Phase 7).
  constraint disclosures_organization_id_id_key unique (organization_id, id)
);

-- The lookup the cascade from ai_systems uses.
create index disclosures_organization_id_ai_system_id_idx
  on public.disclosures (organization_id, ai_system_id);

alter table public.disclosures enable row level security;

comment on table public.disclosures is
  'Published versions of an AI system''s disclosure. Never updated; a change is a new version.';

-- Version, author and time are the database's, whatever a writer sends.
--
-- Everything here runs as the caller, before RLS has checked the row, so
-- it first requires the organization and AI system pair to be one the
-- caller can see. Without that, a caller naming their own organization and
-- another's system would count none of that system's versions, try
-- version 1, and get a unique violation if the system had one and a
-- foreign-key error if not: an answer to whether a stranger's system has a
-- disclosure. Now both cases get the same foreign-key error, as does a
-- system that doesn't exist. Past the check, the caller can read every
-- version of the system, so the count is right; and no one takes the lock
-- below on a system they can't see.
--
-- The lock makes two publishes for one system take turns, so the second
-- reads the first's version and takes the next. Each statement in this
-- function reads a fresh snapshot, so the count runs after the lock is
-- held. The unique key above is the backstop.
create function private.set_disclosure_version()
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
  new.created_by := v_actor;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.set_disclosure_version()
  from public, anon, authenticated;

create trigger disclosures_set_version
  before insert on public.disclosures
  for each row execute function private.set_disclosure_version();

-- A published version is immutable (PLAN Phase 5, security invariant 1):
-- no writer updates a row, the service role included, short of the table
-- owner disabling this trigger. Users have no update grant either.
create function private.refuse_disclosure_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a published disclosure version is never changed; publish a new version'
    using errcode = '42501';
end;
$$;

revoke all on function private.refuse_disclosure_update()
  from public, anon, authenticated;

create trigger disclosures_refuse_update
  before update on public.disclosures
  for each row execute function private.refuse_disclosure_update();

-- No deletes, as for deployments. Deleting the organization or the AI
-- system still takes its versions with it: by the time a cascade reaches
-- this row, the parent that was deleted is gone. Both are checked, because
-- the organization's delete reaches this table by two foreign keys, in no
-- promised order.
create function private.refuse_disclosure_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations where id = old.organization_id)
    and exists (
      select 1 from public.ai_systems
      where organization_id = old.organization_id and id = old.ai_system_id
    )
  then
    raise exception 'disclosure versions are never deleted'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke all on function private.refuse_disclosure_delete()
  from public, anon, authenticated;

create trigger disclosures_refuse_delete
  before delete on public.disclosures
  for each row execute function private.refuse_disclosure_delete();

-- A truncate would skip the row triggers above.
create function private.refuse_disclosure_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'disclosure versions are never deleted'
    using errcode = '42501';
end;
$$;

revoke all on function private.refuse_disclosure_truncate()
  from public, anon, authenticated;

create trigger disclosures_refuse_truncate
  before truncate on public.disclosures
  for each statement execute function private.refuse_disclosure_truncate();

-- Nothing is published under an archived AI system, as for deployments.
--
-- After the row is written, so RLS has already refused a caller outside the
-- organization and this never reports on someone else's system. It runs as
-- the caller, and `for share` makes it and a concurrent archive of the
-- system take turns: whichever commits first, the other sees it.
create function private.require_active_ai_system_for_disclosure()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform
  from public.ai_systems
  where organization_id = new.organization_id
    and id = new.ai_system_id
    and status = 'active'
  for share;

  if not found then
    raise exception 'a disclosure''s AI system is archived'
      using errcode = '23514', constraint = 'disclosures_ai_system_active';
  end if;
  return null;
end;
$$;

revoke all on function private.require_active_ai_system_for_disclosure()
  from public, anon, authenticated;

create trigger disclosures_require_active_ai_system
  after insert on public.disclosures
  for each row execute function private.require_active_ai_system_for_disclosure();

-- The audit row for every version, in the same transaction. Security
-- definer, because users have no insert grant on audit_events. The actor is
-- the row's author, which the trigger above took from the JWT; no metadata
-- is written, so customer text stays out of the log (PLAN Phase 12).
-- `disclosure.published` has been an event type since TASK-006.
create function private.audit_disclosure_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_events
    (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values
    (new.organization_id, new.created_by, 'disclosure.published', 'disclosure',
     new.id, '{}'::jsonb);
  return null;
end;
$$;

revoke all on function private.audit_disclosure_published()
  from public, anon, authenticated;

create trigger disclosures_audit_insert
  after insert on public.disclosures
  for each row execute function private.audit_disclosure_published();

-- Grants. Start from nothing. A user names the organization, system,
-- message, language and whether it is shown; everything else is the
-- database's. No update or delete grant: a change is a new version.
revoke all on table public.disclosures from anon, authenticated;

grant select on table public.disclosures to authenticated;
grant insert (organization_id, ai_system_id, message, language, enabled)
  on table public.disclosures to authenticated;

-- Every member of a live organization reads its disclosures.
create policy disclosures_select_member
  on public.disclosures
  for select
  to authenticated
  using (
    authz.has_org_role(
      organization_id,
      array['owner', 'admin', 'member', 'viewer']
    )
  );

-- Members and up publish (`disclosures.manage`).
create policy disclosures_insert_member
  on public.disclosures
  for insert
  to authenticated
  with check (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  );
