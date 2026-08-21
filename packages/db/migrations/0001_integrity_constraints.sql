-- ============================================================================
-- 0001 — Integrity constraints a schema generator cannot infer.
--
-- These are the constraints that carry the conformance argument. Each one turns
-- an invariant the prototype could only ASSERT in a self-check screen into
-- something the database REFUSES to violate.
--
-- Reviewed by hand. Do not regenerate.
-- ============================================================================

-- Required for exclusion constraints that mix equality (uuid, text) with
-- range overlap (&&) in the same index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Competence windows must not overlap.
--
-- ISO 17034 6.3 asks "was this person authorised for this activity on this
-- day". Two overlapping ACTIVE records make that question ambiguous, and a
-- signature's frozen basis would then be unreproducible.
--
-- Partial: superseded records keep their original range for the historical
-- record, and only live rows are held mutually exclusive.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."competence_records"
  ADD CONSTRAINT competence_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    user_id   WITH =,
    activity  WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  )
  WHERE (superseded_at IS NULL);

ALTER TABLE "lotmark"."competence_records"
  ADD CONSTRAINT competence_range_ordered CHECK (valid_from <= valid_to);

-- ---------------------------------------------------------------------------
-- 2. Calibration intervals must not overlap for the same equipment.
--
-- "Was EQ-02 in calibration on the day of study ST-1001" must have exactly one
-- answer. Two overlapping certificates of calibration make the blast-radius
-- query (which lots are affected) return different results depending on join
-- order.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."calibrations"
  ADD CONSTRAINT calibration_no_overlap
  EXCLUDE USING gist (
    equipment_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );

ALTER TABLE "lotmark"."calibrations"
  ADD CONSTRAINT calibration_range_ordered CHECK (valid_from <= valid_to);

-- ---------------------------------------------------------------------------
-- 3. Study results must match their study's design.
--
-- The prototype stored three differently-shaped result sets in one object and
-- relied on the reader knowing which fields to look at. A homogeneity row with
-- no unit reference silently became a one-unit ANOVA.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."studies"
  ADD CONSTRAINT study_type_known CHECK (
    study_type IN ('homogeneity', 'stability', 'characterisation', 'confirmatory retest')
  );

ALTER TABLE "lotmark"."studies"
  ADD CONSTRAINT study_state_known CHECK (state IN ('draft', 'signed'));

-- A signed study must carry everything a signature commits to.
ALTER TABLE "lotmark"."studies"
  ADD CONSTRAINT study_signed_is_complete CHECK (
    state <> 'signed'
    OR (signed_by_user_id IS NOT NULL AND signed_on IS NOT NULL AND uncertainty IS NOT NULL)
  );

-- Stability studies need a shelf life; u(lts) is meaningless without one.
ALTER TABLE "lotmark"."studies"
  ADD CONSTRAINT stability_has_shelf_life CHECK (
    study_type <> 'stability' OR state <> 'signed' OR shelf_life_to IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4. Certificate issues are numbered from 1 with no gaps in intent, and a
--    withdrawal must state a reason and a person.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_issue_number_positive CHECK (issue_number >= 1);

ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_reissue_states_reason CHECK (
    issue_number = 1 OR reissue_reason IS NOT NULL
  );

ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_withdrawal_is_accountable CHECK (
    withdrawn = false
    OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL AND withdrawn_by_user_id IS NOT NULL)
  );

-- Uncertainty is a magnitude. A negative U on a certificate is not a typo to be
-- corrected later; it is a value that must never have been storable.
ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_uncertainty_non_negative CHECK (expanded_uncertainty >= 0);

ALTER TABLE "lotmark"."certificate_issues"
  ADD CONSTRAINT certificate_coverage_factor_positive CHECK (coverage_factor > 0);

ALTER TABLE "lotmark"."property_values"
  ADD CONSTRAINT property_value_uncertainty_non_negative CHECK (
    combined_uncertainty IS NULL OR combined_uncertainty >= 0
  );

ALTER TABLE "lotmark"."property_values"
  ADD CONSTRAINT property_value_coverage_factor_positive CHECK (coverage_factor > 0);

-- An authorised value must have been assigned first, by somebody.
ALTER TABLE "lotmark"."property_values"
  ADD CONSTRAINT property_value_authorised_is_complete CHECK (
    state <> 'authorised'
    OR (assigned_by IS NOT NULL AND authorised_by IS NOT NULL AND assigned_value IS NOT NULL)
  );

-- SoD-1 as a database constraint, not only a service check. Belt and braces:
-- the guard refuses it with a good message; this makes it impossible.
ALTER TABLE "lotmark"."property_values"
  ADD CONSTRAINT property_value_assigner_is_not_authoriser CHECK (
    authorised_by IS NULL OR assigned_by IS NULL OR authorised_by <> assigned_by
  );

-- ---------------------------------------------------------------------------
-- 5. Quantities and money are non-negative.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."lots"
  ADD CONSTRAINT lot_stock_non_negative CHECK (stock_units >= 0);
ALTER TABLE "lotmark"."lots"
  ADD CONSTRAINT lot_price_non_negative CHECK (unit_price_minor >= 0);
ALTER TABLE "lotmark"."order_lines"
  ADD CONSTRAINT order_line_quantity_positive CHECK (quantity > 0);
ALTER TABLE "lotmark"."order_lines"
  ADD CONSTRAINT order_line_price_non_negative CHECK (unit_price_minor >= 0);
ALTER TABLE "lotmark"."vault_holdings"
  ADD CONSTRAINT vault_quantity_non_negative CHECK (quantity >= 0);

-- A lot cannot supersede itself.
ALTER TABLE "lotmark"."lots"
  ADD CONSTRAINT lot_not_self_superseding CHECK (previous_lot_id IS NULL OR previous_lot_id <> id);

ALTER TABLE "lotmark"."lots"
  ADD CONSTRAINT lot_previous_fk FOREIGN KEY (previous_lot_id)
  REFERENCES "lotmark"."lots"(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 6. The prototype's own defect: a repeat order of the same lot created a
--    second vault row instead of incrementing the first, so the holdings list
--    double-counted. Made impossible.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."vault_holdings"
  ADD CONSTRAINT vault_holding_unique_per_location
  UNIQUE (organisation_id, lot_id, storage_location);

-- ---------------------------------------------------------------------------
-- 7. Excursion and facility ranges are ordered.
-- ---------------------------------------------------------------------------
ALTER TABLE "lotmark"."facility_excursions"
  ADD CONSTRAINT excursion_range_ordered CHECK (from_date <= to_date);

ALTER TABLE "lotmark"."facility_excursions"
  ADD CONSTRAINT excursion_disposition_known CHECK (
    disposition IN ('under assessment', 'accepted', 'rejected')
  );

-- A settled disposition names who settled it.
ALTER TABLE "lotmark"."facility_excursions"
  ADD CONSTRAINT excursion_disposition_is_accountable CHECK (
    disposition = 'under assessment'
    OR (disposition_by_user_id IS NOT NULL AND disposition_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 8. Configuration versioning and the User-Team-Role construct.
--
-- Added when the product became a low-code platform. The constraints here are
-- what stop "deeply configurable" from meaning "no rules at all".
-- ---------------------------------------------------------------------------

-- Foreign keys the generator cannot infer (team ownership is polymorphic in
-- intent but concrete per table).
ALTER TABLE "lotmark"."projects"        ADD CONSTRAINT projects_owner_team_fk        FOREIGN KEY (owner_team_id) REFERENCES "lotmark"."teams"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."studies"         ADD CONSTRAINT studies_owner_team_fk         FOREIGN KEY (owner_team_id) REFERENCES "lotmark"."teams"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."lots"            ADD CONSTRAINT lots_owner_team_fk            FOREIGN KEY (owner_team_id) REFERENCES "lotmark"."teams"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."orders"          ADD CONSTRAINT orders_owner_team_fk          FOREIGN KEY (owner_team_id) REFERENCES "lotmark"."teams"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."capa"            ADD CONSTRAINT capa_owner_team_fk            FOREIGN KEY (owner_team_id) REFERENCES "lotmark"."teams"(id) ON DELETE RESTRICT;

ALTER TABLE "lotmark"."studies"            ADD CONSTRAINT studies_config_version_fk    FOREIGN KEY (config_version_id) REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."property_values"    ADD CONSTRAINT values_config_version_fk     FOREIGN KEY (config_version_id) REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."lots"               ADD CONSTRAINT lots_config_version_fk       FOREIGN KEY (config_version_id) REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;
ALTER TABLE "lotmark"."certificate_issues" ADD CONSTRAINT cert_issues_config_version_fk FOREIGN KEY (config_version_id) REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;

ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_based_on_fk FOREIGN KEY (based_on_version_id)
  REFERENCES "lotmark"."config_versions"(id) ON DELETE RESTRICT;

ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_status_known CHECK (status IN ('draft', 'active', 'superseded'));

-- Exactly one ACTIVE configuration per tenant. Two would make "which rules
-- apply" ambiguous, and every record stamped afterwards unexplainable.
CREATE UNIQUE INDEX config_versions_one_active_per_tenant
  ON "lotmark"."config_versions" (tenant_id) WHERE status = 'active';

-- A published version names who published it and when; a draft names neither.
ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_publication_is_accountable CHECK (
    status = 'draft'
    OR (published_by IS NOT NULL AND published_at IS NOT NULL)
  );

ALTER TABLE "lotmark"."config_versions"
  ADD CONSTRAINT config_version_number_positive CHECK (version_number >= 1);

-- A configuration entry must name a kind the product knows how to validate.
ALTER TABLE "lotmark"."config_entries"
  ADD CONSTRAINT config_entry_kind_known CHECK (
    kind IN ('role','workflow','field','picklist','layout','view','dashboard',
             'report','numbering','template','translation','sod','retention','flag')
  );

-- ── Teams and role assignments ─────────────────────────────────────────────

ALTER TABLE "lotmark"."team_memberships"
  ADD CONSTRAINT membership_range_ordered CHECK (left_on IS NULL OR joined_on <= left_on);

-- One live membership per person per team. Re-joining after leaving is a new
-- row; being in the same team twice at once is a data error.
CREATE UNIQUE INDEX team_memberships_one_live
  ON "lotmark"."team_memberships" (team_id, user_id) WHERE left_on IS NULL;

ALTER TABLE "lotmark"."role_assignments"
  ADD CONSTRAINT role_assignment_range_ordered CHECK (
    valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to
  );

-- The same role, at the same scope, must not be granted twice concurrently:
-- revoking one would leave the other silently in force.
CREATE UNIQUE INDEX role_assignments_no_duplicate_live
  ON "lotmark"."role_assignments" (user_id, role_key, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;

-- A revocation names who did it.
ALTER TABLE "lotmark"."role_assignments"
  ADD CONSTRAINT role_assignment_revocation_is_accountable CHECK (
    revoked_at IS NULL OR revoked_by IS NOT NULL
  );

ALTER TABLE "lotmark"."custom_field_values"
  ADD CONSTRAINT custom_values_is_object CHECK (jsonb_typeof(values) = 'object');
