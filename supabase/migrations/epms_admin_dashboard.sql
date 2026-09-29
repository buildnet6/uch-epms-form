-- Applied to the BuildNET EPMS project on 2026-09-29 (migration "epms_admin_dashboard").
-- Adds: delivered_at, admin_note, complimentary, is_test, data_updated_at on epms_submissions;
-- epms_events (activity log written by triggers), epms_admin (passcode hash), epms_admin_failures (sign-in lockout).
-- All three new tables have row level security on and no policies: only the server (service role) can read them.
-- See the migration history in Supabase for the full statement.

-- 2026-09-29 epms_payment_audit_and_archive
alter table epms_submissions
  add column if not exists tx_refs text[] not null default '{}',   -- every checkout attempt, not only the last
  add column if not exists payment_method text,                    -- 'flutterwave' | 'manual' (confirmed by admin)
  add column if not exists payment_note text,                      -- admin's note for a manual confirmation
  add column if not exists archived boolean not null default false;-- duplicates / not needed, hidden from lists
-- epms_log_activity_after(): 'paid' event says how it was confirmed; logs undo of a manual payment and archive/restore.
