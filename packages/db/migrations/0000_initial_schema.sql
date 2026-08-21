CREATE SCHEMA "lotmark";
--> statement-breakpoint
CREATE TABLE "lotmark"."organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"organisation_type" text,
	"accreditation" text,
	"accreditation_scope" text,
	"phone" text,
	"price_tier" text DEFAULT 'private' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"bilingual" boolean DEFAULT false NOT NULL,
	"adr" boolean DEFAULT false NOT NULL,
	"publications" boolean DEFAULT false NOT NULL,
	"gov_tier" boolean DEFAULT false NOT NULL,
	"conformance_frame" text NOT NULL,
	"lot_numbering_template" text NOT NULL,
	"data_residency" text NOT NULL,
	"out_of_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sod_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"time_source" text DEFAULT 'pool.ntp.org (stratum 2)' NOT NULL,
	"region" text DEFAULT 'eu-central-1' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."competence_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"user_id" uuid NOT NULL,
	"activity" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"basis" text,
	"granted_by_user_id" uuid,
	"superseded_by_record_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mfa_satisfied_at" timestamp with time zone,
	"signing_unlocked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"code" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_encrypted" text,
	"mfa_enrolled_at" timestamp with time zone,
	"mfa_required" boolean DEFAULT true NOT NULL,
	"colour" text,
	"failed_sign_in_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."config_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"overrides_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_reason" text NOT NULL,
	"based_on_version_id" uuid,
	"created_by" uuid NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"signature_id" uuid,
	"change_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"record_id" uuid NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"team_id" uuid,
	"valid_from" date,
	"valid_to" date,
	"granted_by" uuid,
	"granted_reason" text,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_on" date NOT NULL,
	"left_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key_version" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"public_key_pem" text NOT NULL,
	"fingerprint" text NOT NULL,
	"custody" text DEFAULT 'dev_file' NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."audit_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"through_seq" bigint NOT NULL,
	"head_hash" text NOT NULL,
	"entry_count" bigint NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exported_at" timestamp with time zone,
	"export_target" text
);
--> statement-breakpoint
CREATE TABLE "lotmark"."audit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"actor_role_id" text NOT NULL,
	"session_id" uuid,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"subject_table" text,
	"subject_id" text,
	"changes" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_source" text NOT NULL,
	"region" text NOT NULL,
	"entry_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"meaning" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_source" text NOT NULL,
	"region" text NOT NULL,
	"binding_hash" text NOT NULL,
	"signature_value" text,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"canonical_version" text DEFAULT '1' NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"competence_record_id" uuid,
	"competence_activity" text,
	"competence_valid_from" text,
	"competence_valid_to" text,
	"competence_checked_on" text,
	"audit_seq" bigint
);
--> statement-breakpoint
CREATE TABLE "lotmark"."calibrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"certificate_reference" text,
	"performed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"equipment_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"previous_lot_id" uuid,
	"expiry_date" date NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"stock_units" integer DEFAULT 0 NOT NULL,
	"storage_condition" text NOT NULL,
	"cold_chain" boolean DEFAULT false NOT NULL,
	"unit_price_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tierable" boolean DEFAULT true NOT NULL,
	"owner_team_id" uuid,
	"config_version_id" uuid,
	"created_by" uuid,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."process_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"equipment_id" uuid,
	"performed_by_user_id" uuid,
	"performed_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"material_name" text NOT NULL,
	"cas_number" text,
	"sku" text NOT NULL,
	"stage" text DEFAULT 'design' NOT NULL,
	"owner_user_id" uuid,
	"owner_team_id" uuid,
	"intake_quantity" text,
	"target_uncertainty" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."property_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"property_name" text NOT NULL,
	"unit" text NOT NULL,
	"assigned_value" double precision,
	"combined_uncertainty" double precision,
	"coverage_factor" double precision DEFAULT 2 NOT NULL,
	"expanded_uncertainty" double precision,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"config_version_id" uuid,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone,
	"authorised_by" uuid,
	"authorised_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"study_type" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"uncertainty" double precision,
	"estimator_version" text DEFAULT 'guide35-v1' NOT NULL,
	"owner_team_id" uuid,
	"config_version_id" uuid,
	"signed_by_user_id" uuid,
	"signed_on" date,
	"shelf_life_to" date,
	"storage_condition" text,
	"transport_condition" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."study_equipment" (
	"study_id" uuid NOT NULL,
	"equipment_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."study_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"unit_ref" integer,
	"replicate" integer,
	"elapsed_months" integer,
	"laboratory_ref" text,
	"measured_value" double precision NOT NULL,
	"measured_unit" text,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."certificate_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"issue_number" integer NOT NULL,
	"assigned_value" double precision NOT NULL,
	"expanded_uncertainty" double precision NOT NULL,
	"coverage_factor" double precision DEFAULT 2 NOT NULL,
	"property_name" text NOT NULL,
	"unit" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"config_version_id" uuid,
	"reissue_reason" text,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"withdrawn_by_user_id" uuid,
	"document_sha256" text,
	"document_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"lot_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"organisation_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_on" date NOT NULL,
	"supporting_document" text NOT NULL,
	"state" text DEFAULT 'under_review' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"revalidation_due" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."logger_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"celsius" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"subject_table" text,
	"subject_id" text,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"organisation_id" uuid NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"state" text DEFAULT 'placed' NOT NULL,
	"placed_on" date NOT NULL,
	"owner_team_id" uuid,
	"total_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"courier" text,
	"tracking_reference" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"order_id" uuid NOT NULL,
	"temperature_class" text NOT NULL,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."vault_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"storage_location" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."capa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"subject_table" text,
	"subject_id" text,
	"severity" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"owner_user_id" uuid,
	"owner_team_id" uuid,
	"raised_on" date NOT NULL,
	"due_on" date,
	"root_cause" text,
	"corrective_action" text,
	"preventive_action" text,
	"effectiveness_check" text,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"condition" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."facility_excursions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"peak_reading" text,
	"duration_text" text,
	"disposition" text DEFAULT 'under assessment' NOT NULL,
	"disposition_by_user_id" uuid,
	"disposition_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."facility_lots" (
	"facility_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"error_text" text
);
--> statement-breakpoint
CREATE TABLE "lotmark"."legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"retention_classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_table" text,
	"subject_id" text,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"released_by_user_id" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."monitoring_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"checked_on" date NOT NULL,
	"measured_value" text,
	"within_expectation" text,
	"next_due_on" date NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lotmark"."subcontractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"activity" text NOT NULL,
	"accreditation" text NOT NULL,
	"accreditation_valid_to" date NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lotmark"."organisations" ADD CONSTRAINT "organisations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."competence_records" ADD CONSTRAINT "competence_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."competence_records" ADD CONSTRAINT "competence_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "lotmark"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."competence_records" ADD CONSTRAINT "competence_records_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "lotmark"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."users" ADD CONSTRAINT "users_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "lotmark"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."config_entries" ADD CONSTRAINT "config_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."config_entries" ADD CONSTRAINT "config_entries_version_id_config_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "lotmark"."config_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."config_versions" ADD CONSTRAINT "config_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."config_versions" ADD CONSTRAINT "config_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."config_versions" ADD CONSTRAINT "config_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."custom_field_values" ADD CONSTRAINT "custom_field_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."custom_field_values" ADD CONSTRAINT "custom_field_values_config_version_id_config_versions_id_fk" FOREIGN KEY ("config_version_id") REFERENCES "lotmark"."config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "lotmark"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."role_assignments" ADD CONSTRAINT "role_assignments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "lotmark"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."role_assignments" ADD CONSTRAINT "role_assignments_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."role_assignments" ADD CONSTRAINT "role_assignments_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."team_memberships" ADD CONSTRAINT "team_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "lotmark"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "lotmark"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."signing_keys" ADD CONSTRAINT "signing_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."audit_checkpoints" ADD CONSTRAINT "audit_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."audit_ledger" ADD CONSTRAINT "audit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."audit_ledger" ADD CONSTRAINT "audit_ledger_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."signatures" ADD CONSTRAINT "signatures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."signatures" ADD CONSTRAINT "signatures_signer_user_id_users_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "lotmark"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."calibrations" ADD CONSTRAINT "calibrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."calibrations" ADD CONSTRAINT "calibrations_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "lotmark"."equipment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."equipment" ADD CONSTRAINT "equipment_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."lots" ADD CONSTRAINT "lots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."lots" ADD CONSTRAINT "lots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "lotmark"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."lots" ADD CONSTRAINT "lots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."lots" ADD CONSTRAINT "lots_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."process_steps" ADD CONSTRAINT "process_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."process_steps" ADD CONSTRAINT "process_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "lotmark"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."process_steps" ADD CONSTRAINT "process_steps_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "lotmark"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."process_steps" ADD CONSTRAINT "process_steps_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."property_values" ADD CONSTRAINT "property_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."property_values" ADD CONSTRAINT "property_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "lotmark"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."property_values" ADD CONSTRAINT "property_values_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."property_values" ADD CONSTRAINT "property_values_authorised_by_users_id_fk" FOREIGN KEY ("authorised_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."studies" ADD CONSTRAINT "studies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."studies" ADD CONSTRAINT "studies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "lotmark"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."studies" ADD CONSTRAINT "studies_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."study_equipment" ADD CONSTRAINT "study_equipment_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "lotmark"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."study_equipment" ADD CONSTRAINT "study_equipment_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "lotmark"."equipment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."study_results" ADD CONSTRAINT "study_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."study_results" ADD CONSTRAINT "study_results_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "lotmark"."studies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."study_results" ADD CONSTRAINT "study_results_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificate_issues" ADD CONSTRAINT "certificate_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificate_issues" ADD CONSTRAINT "certificate_issues_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "lotmark"."certificates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificate_issues" ADD CONSTRAINT "certificate_issues_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificate_issues" ADD CONSTRAINT "certificate_issues_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificates" ADD CONSTRAINT "certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."certificates" ADD CONSTRAINT "certificates_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "lotmark"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."entitlements" ADD CONSTRAINT "entitlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."entitlements" ADD CONSTRAINT "entitlements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "lotmark"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."entitlements" ADD CONSTRAINT "entitlements_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."entitlements" ADD CONSTRAINT "entitlements_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."logger_readings" ADD CONSTRAINT "logger_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."logger_readings" ADD CONSTRAINT "logger_readings_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "lotmark"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "lotmark"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."order_lines" ADD CONSTRAINT "order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "lotmark"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."order_lines" ADD CONSTRAINT "order_lines_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "lotmark"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."orders" ADD CONSTRAINT "orders_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "lotmark"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."orders" ADD CONSTRAINT "orders_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."shipments" ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "lotmark"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."vault_holdings" ADD CONSTRAINT "vault_holdings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."vault_holdings" ADD CONSTRAINT "vault_holdings_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "lotmark"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."vault_holdings" ADD CONSTRAINT "vault_holdings_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "lotmark"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."capa" ADD CONSTRAINT "capa_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."capa" ADD CONSTRAINT "capa_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facilities" ADD CONSTRAINT "facilities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facility_excursions" ADD CONSTRAINT "facility_excursions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facility_excursions" ADD CONSTRAINT "facility_excursions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "lotmark"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facility_excursions" ADD CONSTRAINT "facility_excursions_disposition_by_user_id_users_id_fk" FOREIGN KEY ("disposition_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facility_lots" ADD CONSTRAINT "facility_lots_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "lotmark"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."facility_lots" ADD CONSTRAINT "facility_lots_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "lotmark"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."job_runs" ADD CONSTRAINT "job_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."legal_holds" ADD CONSTRAINT "legal_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."legal_holds" ADD CONSTRAINT "legal_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."legal_holds" ADD CONSTRAINT "legal_holds_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."monitoring_points" ADD CONSTRAINT "monitoring_points_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."monitoring_points" ADD CONSTRAINT "monitoring_points_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "lotmark"."studies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."monitoring_points" ADD CONSTRAINT "monitoring_points_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "lotmark"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lotmark"."subcontractors" ADD CONSTRAINT "subcontractors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "lotmark"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisations_tenant_code_unique" ON "lotmark"."organisations" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "lotmark"."tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "competence_tenant_code_unique" ON "lotmark"."competence_records" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "competence_lookup_idx" ON "lotmark"."competence_records" USING btree ("user_id","activity","valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "lotmark"."sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "lotmark"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "lotmark"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_unique" ON "lotmark"."users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_code_unique" ON "lotmark"."users" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "users_organisation_idx" ON "lotmark"."users" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_entries_version_kind_key_unique" ON "lotmark"."config_entries" USING btree ("version_id","kind","key");--> statement-breakpoint
CREATE INDEX "config_entries_kind_idx" ON "lotmark"."config_entries" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "config_versions_tenant_number_unique" ON "lotmark"."config_versions" USING btree ("tenant_id","version_number");--> statement-breakpoint
CREATE INDEX "config_versions_status_idx" ON "lotmark"."config_versions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_record_unique" ON "lotmark"."custom_field_values" USING btree ("entity","record_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_entity_idx" ON "lotmark"."custom_field_values" USING btree ("tenant_id","entity");--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "lotmark"."role_assignments" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE INDEX "role_assignments_team_idx" ON "lotmark"."role_assignments" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_memberships_lookup_idx" ON "lotmark"."team_memberships" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE INDEX "team_memberships_team_idx" ON "lotmark"."team_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_tenant_key_unique" ON "lotmark"."teams" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_tenant_version_unique" ON "lotmark"."signing_keys" USING btree ("tenant_id","key_version");--> statement-breakpoint
CREATE INDEX "signing_keys_active_idx" ON "lotmark"."signing_keys" USING btree ("tenant_id","retired_at");--> statement-breakpoint
CREATE INDEX "audit_checkpoints_tenant_time_idx" ON "lotmark"."audit_checkpoints" USING btree ("tenant_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_tenant_seq_unique" ON "lotmark"."audit_ledger" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_tenant_time_idx" ON "lotmark"."audit_ledger" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "lotmark"."audit_ledger" USING btree ("subject_table","subject_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "lotmark"."audit_ledger" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_kind_idx" ON "lotmark"."audit_ledger" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "signatures_subject_idx" ON "lotmark"."signatures" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "signatures_signer_idx" ON "lotmark"."signatures" USING btree ("signer_user_id");--> statement-breakpoint
CREATE INDEX "calibrations_equipment_idx" ON "lotmark"."calibrations" USING btree ("equipment_id","valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_tenant_code_unique" ON "lotmark"."equipment" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_tenant_code_unique" ON "lotmark"."lots" USING btree ("tenant_id","lot_code");--> statement-breakpoint
CREATE INDEX "lots_project_idx" ON "lotmark"."lots" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "lots_state_idx" ON "lotmark"."lots" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "process_steps_project_idx" ON "lotmark"."process_steps" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_tenant_code_unique" ON "lotmark"."projects" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "projects_stage_idx" ON "lotmark"."projects" USING btree ("tenant_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "property_values_tenant_code_unique" ON "lotmark"."property_values" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "property_values_project_idx" ON "lotmark"."property_values" USING btree ("project_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "studies_tenant_code_unique" ON "lotmark"."studies" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "studies_project_idx" ON "lotmark"."studies" USING btree ("project_id","study_type","state");--> statement-breakpoint
CREATE UNIQUE INDEX "study_equipment_pk" ON "lotmark"."study_equipment" USING btree ("study_id","equipment_id");--> statement-breakpoint
CREATE INDEX "study_equipment_equipment_idx" ON "lotmark"."study_equipment" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "study_results_study_idx" ON "lotmark"."study_results" USING btree ("study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_issues_cert_number_unique" ON "lotmark"."certificate_issues" USING btree ("certificate_id","issue_number");--> statement-breakpoint
CREATE INDEX "certificate_issues_cert_idx" ON "lotmark"."certificate_issues" USING btree ("certificate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_tenant_code_unique" ON "lotmark"."certificates" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "certificates_lot_unique" ON "lotmark"."certificates" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_tenant_code_unique" ON "lotmark"."entitlements" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "entitlements_organisation_idx" ON "lotmark"."entitlements" USING btree ("organisation_id","state");--> statement-breakpoint
CREATE INDEX "logger_readings_shipment_idx" ON "lotmark"."logger_readings" USING btree ("shipment_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "lotmark"."notifications" USING btree ("recipient_user_id","read_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "lotmark"."order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_lot_idx" ON "lotmark"."order_lines" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_code_unique" ON "lotmark"."orders" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "orders_organisation_idx" ON "lotmark"."orders" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "lotmark"."orders" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_tenant_code_unique" ON "lotmark"."shipments" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "lotmark"."shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "vault_holdings_organisation_idx" ON "lotmark"."vault_holdings" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capa_tenant_code_unique" ON "lotmark"."capa" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "capa_state_idx" ON "lotmark"."capa" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_tenant_code_unique" ON "lotmark"."facilities" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "facility_excursions_facility_idx" ON "lotmark"."facility_excursions" USING btree ("facility_id","from_date");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_lots_pk" ON "lotmark"."facility_lots" USING btree ("facility_id","lot_id");--> statement-breakpoint
CREATE INDEX "facility_lots_lot_idx" ON "lotmark"."facility_lots" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "job_runs_name_idx" ON "lotmark"."job_runs" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "lotmark"."legal_holds" USING btree ("tenant_id","released_at");--> statement-breakpoint
CREATE INDEX "monitoring_points_study_idx" ON "lotmark"."monitoring_points" USING btree ("study_id","checked_on");--> statement-breakpoint
CREATE INDEX "monitoring_points_due_idx" ON "lotmark"."monitoring_points" USING btree ("tenant_id","next_due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "subcontractors_tenant_code_unique" ON "lotmark"."subcontractors" USING btree ("tenant_id","code");