-- Review follow-ups to the last-owner trigger (TASK-004a).
--
-- 1. Take `for no key update` instead of `for update` on the organization row.
--    Two owner checks still wait for each other, but inserting a membership,
--    whose foreign key takes `for key share` on the same row, is no longer
--    blocked, and cannot deadlock with an owner change.
-- 2. Refuse to decide under repeatable read. There the check's snapshot is
--    taken before the lock is granted, so two owners demoting each other at
--    once both see the other still an owner and the organization is left with
--    none (reproduced locally). Read committed, which the Data API uses,
--    re-reads after the lock; serializable detects the conflict and aborts one
--    transaction. Both are safe and allowed.
create or replace function private.ensure_organization_keeps_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return null;
  end if;

  if tg_op = 'UPDATE'
    and new.role = 'owner'
    and new.organization_id = old.organization_id then
    return null;
  end if;

  if current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'owner changes must run under read committed or serializable isolation'
      using errcode = '25000';
  end if;

  perform 1
  from public.organizations
  where id = old.organization_id
  for no key update;

  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.memberships
    where organization_id = old.organization_id
      and role = 'owner'
  ) then
    raise exception 'an organization must keep at least one owner'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

revoke all on function private.ensure_organization_keeps_an_owner()
  from public, anon, authenticated;
