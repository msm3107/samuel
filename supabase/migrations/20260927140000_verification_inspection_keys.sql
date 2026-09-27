-- The inspection keys, added to the verification metadata whitelist
-- (TASK-024). Additive: no column is added, dropped or retyped, no failure
-- code is added or removed, and `verification_checks` still holds no rows.
--
-- Why a second migration against the same constraint. TASK-023 created the
-- whitelist with the eight keys the fetch produces and said this task would
-- add the inspection keys in its own migration, deliberately: widening a
-- whitelist by a named migration is an act somebody reviews, which is the
-- opposite of drift. The cost was accepted there and is paid here — a check
-- constraint has no `add value`, so the whole list is dropped and re-added,
-- which is the same cost TASK-022 accepted when it chose text with a
-- constraint over a Postgres enum.
--
-- Three keys, and what each one is for:
--
--   `charset`      — which encoding the body was read as. A page read with the
--                    wrong encoding is a page whose script tag we may not
--                    find, recorded as WIDGET_NOT_FOUND against a customer who
--                    complied. This is the only record of which of three
--                    sources decided it.
--   `widget_tags`  — how many tags loading this installation's widget the page
--                    carries. A count, never an identifier: see below.
--   `widget_reason`— which of seven observations explains the answer.
--
-- Why `widget_reason` exists at all: WIDGET_NOT_FOUND is one stored code over
-- "you have no tag", "your tag loads a copy from your own domain" and "your
-- home page is a PDF" — three different fixes — and this is the failure class
-- a customer must act on. It is PR #40 note 2's argument one task later, and
-- §19 governs `failure_code`, not `metadata`. Privacy-safe by construction:
-- seven fixed strings with no customer data in them, bounded as a value by the
-- row schema rather than here, because a constraint on a value is what the
-- whitelist deliberately declines to be.
--
-- Why there is no key holding the deployment ID found on the page. It would be
-- the most useful fact of all for DEPLOYMENT_ID_MISMATCH, and it is refused:
-- an identifier read off a customer's page belongs to some other
-- organization, and copying it into this organization's evidence row is a
-- cross-tenant leak through the one column README §34 exists to protect. The
-- count says a wrong tag was there; support asks the customer which site they
-- copied it from.
--
-- No inspection code is added to §19. WIDGET_NOT_FOUND,
-- DEPLOYMENT_ID_MISMATCH and DISCLOSURE_VERSION_MISMATCH were all reserved by
-- TASK-022. The third is emitted by nothing: the disclosure version the widget
-- renders comes from our own endpoint after a fetch, so it is never in the
-- customer's HTML, and README §18 now says so where it asks the question.

alter table public.verification_checks
  drop constraint verification_checks_metadata_keys_check;

alter table public.verification_checks
  add constraint verification_checks_metadata_keys_check check (
    jsonb_typeof(metadata) <> 'object'
    or metadata - array[
      -- The transport's keys (TASK-023), unchanged ------------------------
      -- Which scheme answered. Plain HTTP is weaker evidence, so it is
      -- recorded rather than assumed (owner, 2026-09-27).
      'scheme',
      -- Whether HTTPS was tried first and failed.
      'https_failed',
      -- How many hops were followed.
      'redirects',
      -- The hostname the body came from, which a chain may have changed.
      'final_host',
      -- Bytes of body read, after decompression.
      'response_bytes',
      -- How long the whole attempt took, any HTTPS attempt included.
      'duration_ms',
      -- The `Content-Type` header as given, so a PDF home page is
      -- explicable rather than mysteriously missing a widget.
      'content_type',
      -- Which redirect rule refused a hop (PR #40 review, note 2).
      'redirect_reason',
      -- The inspection's keys (TASK-024) ----------------------------------
      -- The canonical encoding name the body was read as, from the encoding
      -- standard's own list — never the label the page wrote.
      'charset',
      -- How many tags load this installation's widget. A count, never an
      -- identifier.
      'widget_tags',
      -- Which of the seven observations explains the answer.
      'widget_reason'
    ] = '{}'::jsonb
  );

comment on column public.verification_checks.metadata is
  'Facts about the check, never content fetched from the customer page '
  '(README §34). Bounded three ways: an object, at most 2048 bytes '
  '(TASK-022), and only the keys named in '
  'verification_checks_metadata_keys_check (TASK-023, widened by TASK-024). '
  'A whitelist bounds keys, not values: a new key needs a migration, and the '
  'reviewer of that migration is the last line against page content reaching '
  'this column. No identifier read off a customer page is stored here at '
  'all, because it would belong to another organization.';
