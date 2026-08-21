-- ============================================================================
-- 0024 — An issued password is a shared secret until it is replaced.
--
-- `POST /admin/users` mints a random initial password, hashes it, and returns
-- it once so an administrator can pass it to the person. That is the ordinary
-- way to enrol somebody and it is fine — right up to the moment it is not
-- replaced. Until then the credential is known to at least two people, has
-- travelled through whatever channel the administrator chose, and authorises
-- everything the account can do including electronic signatures.
--
-- The route said so itself, in a comment:
--
--     LIMITATION, stated rather than hidden: there is no forced password
--     change on first sign-in yet, so the initial password remains valid
--     until the person changes it, and there is no screen for that either.
--
-- 21 CFR 11 §11.300(b) requires that identification code and password
-- issuances are "periodically checked, recalled, or revised". §11.300(d)
-- requires transaction safeguards against unauthorised use. An issued password
-- that never expires satisfies neither: it is an issuance that is never
-- revised, used to authenticate acts attributed to one named person.
--
-- ── Why a column and not a convention ───────────────────────────────────────
--
-- The alternative was to infer it — treat `password_changed_at IS NULL` as
-- "must change". That conflates two different facts. An account migrated in
-- from elsewhere, or one created before this column existed, has never changed
-- its password HERE and is not thereby suspect. The obligation is a decision
-- somebody made when the account was provisioned, so it is recorded as one.
--
-- ── Why the default is false ────────────────────────────────────────────────
--
-- Adding this column must not lock out every existing account on deploy. The
-- default is therefore false, and `POST /admin/users` sets it to true
-- explicitly for the accounts it creates — the only accounts that have ever
-- had a password chosen for them by somebody else.
--
-- The seeded demonstration users are exempt by the same rule: their password is
-- published in the sign-in screen on purpose. They are demonstration data, not
-- an issuance to a person.
-- ============================================================================

ALTER TABLE "lotmark"."users"
  ADD COLUMN "password_change_required" boolean NOT NULL DEFAULT false,
  ADD COLUMN "password_changed_at" timestamp with time zone;

COMMENT ON COLUMN "lotmark"."users"."password_change_required" IS
  'The account may authenticate but may not act until its password is replaced. '
  'Set when an administrator provisions an account with a password they chose. '
  'Enforced centrally in requireSession, not per route.';

COMMENT ON COLUMN "lotmark"."users"."password_changed_at" IS
  'When the holder last set their own password. NULL means never — either the '
  'account still carries its issued password, or it predates this column. '
  'Deliberately NOT back-filled from created_at, which would assert a change '
  'that did not happen.';
