-- 039 — rate-limit check-and-consume in one round trip (chat speed, 2026-10-08).
--
-- platform/rateLimit.ts ran this as an interactive transaction: BEGIN, lock,
-- delete, count, insert, COMMIT — six round trips to Neon on every send, sign-in
-- and Pusher auth. The same steps as one function call are one round trip.
--
-- Same semantics as before: the per-key advisory lock (same key as the old
-- code, so a mixed deploy still serialises) is held until the calling
-- statement's transaction ends. Each statement in a VOLATILE plpgsql function
-- takes a fresh snapshot under READ COMMITTED, so the count after the lock sees
-- every hit the previous lock holder committed.

CREATE OR REPLACE FUNCTION rate_limit_consume(
  p_key     text,
  p_now     timestamptz,
  p_seconds integer,
  p_max     integer
) RETURNS TABLE (allowed boolean, retry_after_seconds integer, remaining integer)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_window interval := make_interval(secs => p_seconds);
  v_count  integer;
  v_oldest timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rl:' || p_key));
  DELETE FROM rate_limit_hits h WHERE h.key = p_key AND h.at <= p_now - v_window;
  SELECT count(*)::int, min(h.at) INTO v_count, v_oldest FROM rate_limit_hits h WHERE h.key = p_key;

  IF v_count >= p_max THEN
    -- Rejected without consuming, so a rejected attempt does not extend the lockout.
    RETURN QUERY SELECT false,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (COALESCE(v_oldest, p_now) + v_window - p_now))))::int,
      0;
    RETURN;
  END IF;

  INSERT INTO rate_limit_hits (key, at) VALUES (p_key, p_now);
  RETURN QUERY SELECT true, 0, p_max - v_count - 1;
END
$$;
