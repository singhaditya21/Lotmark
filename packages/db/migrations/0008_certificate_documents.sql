-- ============================================================================
-- 0008 — Certificate documents.
--
-- Until now a certificate was a database row. A certified reference material
-- ships WITH a certificate; without the document, nothing the product exists to
-- produce could leave the building.
--
-- Three properties the schema has to carry:
--
--  1. **Reproducibility.** A certificate issued today must render byte-identical
--     in five years, or "here is the document we issued" is not a checkable
--     claim. That needs the exact inputs frozen (data_snapshot), the template
--     version, and the renderer version — all three, because any one of them
--     changing changes the bytes.
--  2. **Verifiability by a stranger.** The document signature is over the PDF
--     bytes and verifies with the public key alone, so a customer's auditor can
--     check it without an account, a database, or our cooperation.
--  3. **A public handle that leaks nothing.** certificate_number is unique per
--     tenant, not globally, so it cannot address a public URL. An opaque token
--     can, and reveals no tenant, no customer and no sequence.
-- ============================================================================

ALTER TABLE "lotmark"."certificate_issues"
  -- The exact values the document was rendered from. Not a convenience copy:
  -- re-deriving them later from live tables would silently produce a different
  -- document if anything upstream changed.
  ADD COLUMN data_snapshot jsonb,
  ADD COLUMN data_snapshot_digest text,
  ADD COLUMN template_key text,
  ADD COLUMN template_version text,
  ADD COLUMN renderer_version text,
  -- Ed25519 over the PDF bytes, with the key that signed it.
  ADD COLUMN document_signature text,
  ADD COLUMN document_key_version text,
  ADD COLUMN document_bytes integer,
  ADD COLUMN rendered_at timestamptz,
  -- Opaque, unguessable, globally unique. Addresses /verify/:token.
  ADD COLUMN verification_token text;

CREATE UNIQUE INDEX certificate_issues_verification_token_unique
  ON "lotmark"."certificate_issues" (verification_token)
  WHERE verification_token IS NOT NULL;

-- A rendered document names everything needed to reproduce it, or it names none
-- of it. A half-recorded provenance is worse than none: it looks reproducible.
ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_document_provenance_is_whole CHECK (
    document_sha256 IS NULL
    OR (data_snapshot IS NOT NULL
        AND data_snapshot_digest IS NOT NULL
        AND template_key IS NOT NULL
        AND template_version IS NOT NULL
        AND renderer_version IS NOT NULL
        AND document_signature IS NOT NULL
        AND document_key_version IS NOT NULL
        AND rendered_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Public verification lookup.
--
-- SECURITY DEFINER for the same reason as resolve_tenant: a member of the
-- public has no tenant context, and every table is under RLS. It returns only
-- what a certificate already states in print — no customer, no order, no
-- holder, no internal identifier.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".verify_certificate(p_token text)
RETURNS TABLE (
  certificate_code text, lot_code text, issue_number integer,
  property_name text, assigned_value double precision,
  expanded_uncertainty double precision, coverage_factor double precision,
  unit text, issued_at timestamptz, withdrawn boolean, withdrawn_reason text,
  material_name text, expiry_date date, producer_name text,
  document_sha256 text, document_signature text, document_key_version text,
  superseded_by integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  SELECT c.code, l.lot_code, i.issue_number,
         i.property_name, i.assigned_value, i.expanded_uncertainty,
         i.coverage_factor, i.unit, i.issued_at, i.withdrawn, i.withdrawn_reason,
         p.material_name, l.expiry_date, t.name,
         i.document_sha256, i.document_signature, i.document_key_version,
         -- A later issue supersedes this one. A holder checking an old
         -- certificate must be told so, which is the entire point of the page.
         (SELECT max(later.issue_number) FROM "lotmark"."certificate_issues" later
          WHERE later.certificate_id = i.certificate_id AND later.issue_number > i.issue_number)
  FROM "lotmark"."certificate_issues" i
  JOIN "lotmark"."certificates" c ON c.id = i.certificate_id
  JOIN "lotmark"."lots" l ON l.id = c.lot_id
  JOIN "lotmark"."projects" p ON p.id = l.project_id
  JOIN "lotmark"."tenants" t ON t.id = i.tenant_id
  WHERE i.verification_token = p_token;
$$;

GRANT EXECUTE ON FUNCTION "lotmark".verify_certificate(text) TO lotmark_app;

-- The public key, fetchable without a session so a verifier can check a
-- signature independently. Public keys are public; that is what makes them useful.
CREATE OR REPLACE FUNCTION "lotmark".public_signing_key(p_tenant_name text, p_key_version text)
RETURNS TABLE (public_key_pem text, algorithm text, custody text, fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lotmark, pg_temp AS $$
  SELECT k.public_key_pem, k.algorithm, k.custody, k.fingerprint
  FROM "lotmark"."signing_keys" k
  JOIN "lotmark"."tenants" t ON t.id = k.tenant_id
  WHERE t.name = p_tenant_name AND k.key_version = p_key_version;
$$;

GRANT EXECUTE ON FUNCTION "lotmark".public_signing_key(text, text) TO lotmark_app;
