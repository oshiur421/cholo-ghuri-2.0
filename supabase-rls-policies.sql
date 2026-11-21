-- ============================================================================
-- Cholo Ghuri — Supabase Row Level Security (RLS) policies
-- ----------------------------------------------------------------------------
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> New query -> paste this whole
-- file -> Run. Safe to re-run (policies are dropped first).
--
-- WHAT THIS DOES
--   * Enables RLS on every app table. With RLS OFF (the current state), anyone
--     holding the publishable anon key can read/write/delete EVERYTHING.
--     With RLS ON + these policies, the anon key can only do what the app
--     actually needs.
--   * INSERT/UPDATE are guarded by format and range checks (room-code format,
--     Bangladesh lat/lng bounds, vote counters >= 0).
--   * voice_messages is insert + read only (clips are immutable: no UPDATE,
--     no DELETE). police_alerts has no UPDATE policy.
--
-- WHAT THIS DOES *NOT* DO (read before assuming you are safe)
--   * The app has NO login / Supabase Auth. RLS cannot prove "this row is
--     mine" without an authenticated user, so SELECT is open to anon and
--     UPDATE/DELETE cannot be locked to the row owner. Room isolation today
--     relies on the app only ever querying its own room_code. True per-room
--     isolation needs Supabase Auth (each rider signs in) — that is the
--     recommended next step, not something this file can add.
--   * This file does NOT rotate any key. No secret key was ever in the code,
--     so no rotation is required (see SECURITY-SETUP.md).
--
-- TABLES: riders, police_reports, tour_plans, voice_messages (+ police_alerts
-- in its own section at the end — run it only if that table exists).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Grants (RLS policies alone do not grant access; the anon role also needs
--    table privileges. These are the same grants Supabase gives by default.)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.riders TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.police_reports TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tour_plans TO anon;
GRANT SELECT, INSERT ON public.voice_messages TO anon;
-- (police_alerts grant lives in section 5, with its table.)

-- ============================================================================
-- 1. riders — live convoy positions
--    Columns used by the app: id, room_code, rider_name, is_leader, lat, lng,
--    speed, heading, updated_at, subgroup.
--    App needs: insert on join, upsert position (update), read room-mates,
--    delete on leave / kick / stale cleanup / room purge.
-- ============================================================================
ALTER TABLE public.riders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "riders_select" ON public.riders;
CREATE POLICY "riders_select" ON public.riders
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "riders_insert" ON public.riders;
CREATE POLICY "riders_insert" ON public.riders
  FOR INSERT TO anon
  WITH CHECK (
    room_code ~ '^[A-Z0-9]{6,8}$'      -- new 6-char codes + old DHAKA### codes
    AND rider_name IS NOT NULL
    AND char_length(rider_name) BETWEEN 1 AND 60
  );

DROP POLICY IF EXISTS "riders_update" ON public.riders;
CREATE POLICY "riders_update" ON public.riders
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (
    room_code ~ '^[A-Z0-9]{6,8}$'
    AND (lat IS NULL OR (lat BETWEEN 20 AND 27))
    AND (lng IS NULL OR (lng BETWEEN 88 AND 93))
  );

DROP POLICY IF EXISTS "riders_delete" ON public.riders;
CREATE POLICY "riders_delete" ON public.riders
  FOR DELETE TO anon USING (true);

-- ============================================================================
-- 2. police_reports — checkpoint reports + photos + votes
--    Columns used by the app: id, lat, lng, reported_by, photo_data,
--    true_votes, false_votes, created_at.
--    App needs: insert on report, read for the map, update vote counters,
--    delete on auto-removal (10 false votes) / room purge.
-- ============================================================================
ALTER TABLE public.police_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "police_reports_select" ON public.police_reports;
CREATE POLICY "police_reports_select" ON public.police_reports
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "police_reports_insert" ON public.police_reports;
CREATE POLICY "police_reports_insert" ON public.police_reports
  FOR INSERT TO anon
  WITH CHECK (
    lat BETWEEN 20 AND 27                  -- Bangladesh bounds
    AND lng BETWEEN 88 AND 93
    AND (true_votes IS NULL OR true_votes >= 0)
    AND (false_votes IS NULL OR false_votes >= 0)
    AND (photo_data IS NULL OR photo_data LIKE 'data:image/%')
  );

DROP POLICY IF EXISTS "police_reports_update" ON public.police_reports;
CREATE POLICY "police_reports_update" ON public.police_reports
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (
    lat BETWEEN 20 AND 27
    AND lng BETWEEN 88 AND 93
    AND (true_votes IS NULL OR true_votes >= 0)
    AND (false_votes IS NULL OR false_votes >= 0)
  );

DROP POLICY IF EXISTS "police_reports_delete" ON public.police_reports;
CREATE POLICY "police_reports_delete" ON public.police_reports
  FOR DELETE TO anon USING (true);

-- ============================================================================
-- 3. tour_plans — shared tour route for a room
--    Columns used by the app: id, room_code, subgroup, name, creator_id,
--    creator_name, waypoints, current_stop_index, status, created_at,
--    updated_at.
--    App needs: insert on activate, read latest active plan, update progress,
--    delete on end-tour / room purge.
-- ============================================================================
ALTER TABLE public.tour_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tour_plans_select" ON public.tour_plans;
CREATE POLICY "tour_plans_select" ON public.tour_plans
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "tour_plans_insert" ON public.tour_plans;
CREATE POLICY "tour_plans_insert" ON public.tour_plans
  FOR INSERT TO anon
  WITH CHECK (room_code ~ '^[A-Z0-9]{6,8}$');

DROP POLICY IF EXISTS "tour_plans_update" ON public.tour_plans;
CREATE POLICY "tour_plans_update" ON public.tour_plans
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (room_code ~ '^[A-Z0-9]{6,8}$');

DROP POLICY IF EXISTS "tour_plans_delete" ON public.tour_plans;
CREATE POLICY "tour_plans_delete" ON public.tour_plans
  FOR DELETE TO anon USING (true);

-- ============================================================================
-- 4. voice_messages — walkie-talkie clips (immutable)
--    Columns used by the app: room_code, sender_id, sender_name, audio_data,
--    created_at.
--    App needs: insert on send, read recent clips. NOTHING in the app updates
--    or deletes a clip, so there is deliberately NO update/delete policy —
--    those operations are denied for anon.
-- ============================================================================
ALTER TABLE public.voice_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voice_messages_select" ON public.voice_messages;
CREATE POLICY "voice_messages_select" ON public.voice_messages
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "voice_messages_insert" ON public.voice_messages;
CREATE POLICY "voice_messages_insert" ON public.voice_messages
  FOR INSERT TO anon
  WITH CHECK (
    room_code ~ '^[A-Z0-9]{6,8}$'
    AND sender_id IS NOT NULL
    AND audio_data IS NOT NULL
  );

-- No UPDATE policy and no DELETE policy on voice_messages (immutable clips).

-- ============================================================================
-- 5. police_alerts — ONLY if this table exists in your project.
--    The app only references it in the room-purge delete
--    (police_alerts?room_code=eq.<ROOM>). If the Table Editor shows no
--    police_alerts table, DELETE THIS WHOLE SECTION before running — otherwise
--    the script stops at the GRANT below and nothing is applied.
--    No UPDATE policy: nothing in the app updates an alert row.
-- ============================================================================
GRANT SELECT, INSERT, DELETE ON public.police_alerts TO anon;
ALTER TABLE public.police_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "police_alerts_select" ON public.police_alerts;
CREATE POLICY "police_alerts_select" ON public.police_alerts
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "police_alerts_insert" ON public.police_alerts;
CREATE POLICY "police_alerts_insert" ON public.police_alerts
  FOR INSERT TO anon
  WITH CHECK (room_code ~ '^[A-Z0-9]{6,8}$');

DROP POLICY IF EXISTS "police_alerts_delete" ON public.police_alerts;
CREATE POLICY "police_alerts_delete" ON public.police_alerts
  FOR DELETE TO anon USING (true);

-- No UPDATE policy on police_alerts.

-- ============================================================================
-- 6. OPTIONAL — server-side one-vote-per-rider (LOW-1 hardening)
--    The app already enforces one vote per rider on the device (localStorage).
--    This table is the server-side version: one row per (report, voter), so a
--    voter can never be counted twice even from a fresh browser. It is
--    OPTIONAL and dormant until the app is taught to write to it — run it now
--    if you want the table ready, or skip it.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.police_report_votes (
  report_id  text NOT NULL,
  voter_id   text NOT NULL,
  vote       text NOT NULL CHECK (vote IN ('true', 'false')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, voter_id)
);

ALTER TABLE public.police_report_votes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.police_report_votes TO anon;

DROP POLICY IF EXISTS "police_report_votes_select" ON public.police_report_votes;
CREATE POLICY "police_report_votes_select" ON public.police_report_votes
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "police_report_votes_insert" ON public.police_report_votes;
CREATE POLICY "police_report_votes_insert" ON public.police_report_votes
  FOR INSERT TO anon
  WITH CHECK (report_id <> '' AND voter_id <> '' AND vote IN ('true', 'false'));

-- No UPDATE / DELETE policy on police_report_votes (a vote is final).

-- ============================================================================
-- Verify after running (SQL Editor):
--   SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE schemaname = 'public' ORDER BY tablename, cmd;
-- You should see policies listed for riders, police_reports, tour_plans,
-- voice_messages (and police_alerts / police_report_votes if you ran them).
-- ============================================================================
