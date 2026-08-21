-- ============================================================================
-- 0014 — Point-in-time ("as at") querying.
--
-- The prototype resolved every date-sensitive question against an ASOF()
-- helper, so the whole product could be asked "as at" a past date rather than
-- only today. That is not a reporting nicety: an assessor's central question is
-- "was this person authorised ON THE DAY they signed", and answering it with
-- today's competence table is answering a different question.
--
-- ── Why a trigger and not a convention ──────────────────────────────────────
--
-- While as_of is set, every business table must refuse writes. A convention —
-- "don't write in as-of mode" — fails the moment one call path forgets, and the
-- failure is a BACKDATED RECORD: a signature, a value, a lot that appears to
-- have existed at a time it did not. That is the single worst thing this
-- schema could permit, so it is enforced where it cannot be forgotten.
--
-- The trigger goes on EVERY table, including the ones written by other triggers
-- (audit_head) and by SECURITY DEFINER functions (numbering_counters). Those
-- writes only ever happen as part of a business write, which is already
-- refused — but exempting them would leave exactly the paths that bypass
-- ordinary checks as the ones able to write under as_of.
-- ============================================================================

/**
 * The acting as-of date, or NULL for "now".
 *
 * NULL, not an error, when unset: the overwhelming majority of queries run at
 * the present moment and should not each have to say so.
 */
CREATE OR REPLACE FUNCTION "lotmark".as_of() RETURNS date
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('lotmark.as_of', true);
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::date;
EXCEPTION WHEN others THEN
  -- A malformed setting must not silently become "now". A caller that meant to
  -- ask about the past and got the present would draw a wrong conclusion and
  -- have no way to notice.
  RAISE EXCEPTION 'lotmark.as_of is set to %, which is not a date', v;
END;
$$;

/**
 * The date a query should resolve against: the as-of date, or today.
 *
 * Every temporal predicate uses this rather than current_date, so switching a
 * session into the past changes every answer consistently instead of some.
 */
CREATE OR REPLACE FUNCTION "lotmark".effective_date() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT COALESCE("lotmark".as_of(), current_date);
$$;

/**
 * Refuse every write while as_of is set.
 *
 * Not "log a warning", not "ignore the setting" — refuse. A write performed
 * while the session believes it is in the past is a backdated record, and no
 * downstream check can undo one.
 */
CREATE OR REPLACE FUNCTION "lotmark".refuse_write_under_as_of() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v date;
BEGIN
  v := "lotmark".as_of();
  IF v IS NOT NULL THEN
    RAISE EXCEPTION
      'this session is reading as at %, so % on % is refused. '
      'Clear lotmark.as_of before writing.',
      v, TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'lotmark' AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    -- CREATE OR REPLACE so a later table-wide sweep can re-run this without
    -- colliding on triggers that already exist.
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER as_of_read_only
         BEFORE INSERT OR UPDATE OR DELETE ON "lotmark".%I
         FOR EACH ROW EXECUTE FUNCTION "lotmark".refuse_write_under_as_of()',
      t.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Setting it. as_of can never exceed today.
--
-- A future as_of would let a caller ask what the records WILL say — and, worse,
-- combined with any path that escaped the read-only trigger, would let them
-- write a record dated after now. There is no legitimate question it answers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "lotmark".set_as_of(p_date date) RETURNS date
LANGUAGE plpgsql AS $$
BEGIN
  IF p_date IS NULL THEN
    PERFORM set_config('lotmark.as_of', '', true);
    RETURN NULL;
  END IF;
  IF p_date > current_date THEN
    RAISE EXCEPTION 'as-of % is in the future; the records cannot answer that', p_date;
  END IF;
  PERFORM set_config('lotmark.as_of', p_date::text, true);
  RETURN p_date;
END;
$$;

GRANT EXECUTE ON FUNCTION "lotmark".as_of() TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".effective_date() TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".set_as_of(date) TO lotmark_app;

-- ---------------------------------------------------------------------------
-- The temporal answers themselves.
--
-- These are the questions an assessor actually asks, expressed so they resolve
-- against effective_date() rather than today.
-- ---------------------------------------------------------------------------

/** Was this person authorised for this activity, as at the acting date? */
CREATE OR REPLACE FUNCTION "lotmark".competence_as_of(p_user uuid, p_activity text)
RETURNS TABLE (id uuid, code text, valid_from date, valid_to date, basis text)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.code, c.valid_from, c.valid_to, c.basis
  FROM "lotmark"."competence_records" c
  WHERE c.user_id = p_user AND c.activity = p_activity
    AND c.valid_from <= "lotmark".effective_date()
    AND c.valid_to   >= "lotmark".effective_date()
    -- Superseded AFTER the acting date still counts: it was live then.
    AND (c.superseded_at IS NULL OR c.superseded_at::date > "lotmark".effective_date());
$$;

/** Was this equipment in calibration, as at the acting date? */
CREATE OR REPLACE FUNCTION "lotmark".calibration_as_of(p_equipment uuid)
RETURNS TABLE (id uuid, valid_from date, valid_to date, certificate_reference text)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.valid_from, c.valid_to, c.certificate_reference
  FROM "lotmark"."calibrations" c
  WHERE c.equipment_id = p_equipment
    AND c.valid_from <= "lotmark".effective_date()
    AND c.valid_to   >= "lotmark".effective_date();
$$;

/**
 * The lot register as at a date.
 *
 * State is not stored historically, so it is reconstructed from
 * state_transitions — which is why that table being append-only matters beyond
 * tidiness: it is the only record of what a lot's state USED to be.
 */
CREATE OR REPLACE FUNCTION "lotmark".lot_state_as_of(p_lot uuid)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT st.to_state FROM "lotmark"."state_transitions" st
     WHERE st.subject_type = 'lot' AND st.subject_id = p_lot
       AND st.occurred_at::date <= "lotmark".effective_date()
     ORDER BY st.occurred_at DESC LIMIT 1),
    -- No transition on or before the date: the lot did not exist yet.
    NULL);
$$;

GRANT EXECUTE ON FUNCTION "lotmark".competence_as_of(uuid, text) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".calibration_as_of(uuid) TO lotmark_app;
GRANT EXECUTE ON FUNCTION "lotmark".lot_state_as_of(uuid) TO lotmark_app;
