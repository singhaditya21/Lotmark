-- ============================================================================
-- 0013 — The signer must be able to register its own public key.
--
-- 0012 granted lotmark_signer SELECT on signing_keys but not INSERT, so the
-- first anchoring run wrote the private key FILE, then failed registering the
-- public half. The next run found the file, skipped registration entirely, and
-- produced a signed anchor whose public key was nowhere — an attestation
-- nobody could verify.
--
-- Two things were wrong and both are fixed:
--   * the grant (here);
--   * the code treating "the file exists" as proof of "the key is registered"
--     (in anchor.ts — the two are checked independently now).
--
-- Registering a PUBLIC key is not a privilege escalation: it is public by
-- definition, and the purpose CHECK plus the one-active-per-purpose index stop
-- the signer registering anything but an anchor key.
-- ============================================================================

GRANT INSERT ON "lotmark"."signing_keys" TO lotmark_signer;

/**
 * The signer may register anchor keys only.
 *
 * A row-level policy rather than a grant, because the distinction is per-row:
 * the signer must never be able to register a RECORD key, which would let it
 * mint an identity capable of signing certificates.
 */
CREATE POLICY signer_registers_anchor_keys_only ON "lotmark"."signing_keys"
  FOR INSERT TO lotmark_signer
  WITH CHECK (tenant_id = "lotmark".current_tenant() AND purpose = 'anchor');

-- The pre-existing tenant_isolation policy is PERMISSIVE and applies to every
-- role, so the signer's INSERT is allowed if EITHER policy passes. Making the
-- anchor-only rule restrictive would break the application's own inserts, so
-- instead the signer is denied the broad policy by a restrictive rule that only
-- constrains that role.
CREATE POLICY signer_never_writes_record_keys ON "lotmark"."signing_keys"
  AS RESTRICTIVE FOR INSERT TO lotmark_signer
  WITH CHECK (purpose = 'anchor');
