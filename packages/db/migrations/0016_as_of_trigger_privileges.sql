-- ============================================================================
-- 0016 — The read-only trigger must work for every writing role.
--
-- Two features built in the same session collided:
--
--   * 0014 put an as_of_read_only trigger on EVERY table.
--   * 0015 revoked EXECUTE on every function from PUBLIC.
--
-- The trigger function calls lotmark.as_of(), and a trigger runs with the
-- CALLER's privileges. So lotmark_signer — which holds INSERT on
-- audit_checkpoints and needs nothing else — began failing with
-- "permission denied for function as_of" the moment it tried to write an anchor.
--
-- Granting as_of() to each writing role would work and would be wrong: every
-- future role would need the same grant, and forgetting it fails at write time,
-- in a job, at 3am. The guard belongs to the schema, not to the caller.
--
-- SECURITY DEFINER on the trigger function is safe here in a way it usually is
-- not: it reads one session setting and either returns or raises. It touches no
-- table, takes no argument, and returns no data, so there is nothing for a
-- caller to influence or extract.
-- ============================================================================

CREATE OR REPLACE FUNCTION "lotmark".refuse_write_under_as_of() RETURNS trigger
LANGUAGE plpgsql
-- Runs as the owner so that ANY role able to write a row is subject to the
-- check without needing a grant it would be easy to forget.
SECURITY DEFINER SET search_path = lotmark, pg_temp
AS $$
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

-- A trigger function is invoked by the trigger, never called directly, so no
-- role needs EXECUTE on it. Revoking makes that explicit rather than incidental.
REVOKE EXECUTE ON FUNCTION "lotmark".refuse_write_under_as_of() FROM PUBLIC;

-- as_of() and effective_date() read a session setting and grant no access to
-- anything, so the roles that query temporally may call them directly.
GRANT EXECUTE ON FUNCTION "lotmark".as_of()          TO lotmark_signer;
GRANT EXECUTE ON FUNCTION "lotmark".effective_date() TO lotmark_signer;
