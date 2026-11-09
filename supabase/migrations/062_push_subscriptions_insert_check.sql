-- ============================================================
-- 062_push_subscriptions_insert_check.sql
--
-- Tighten push_subscriptions INSERT: the row's account_id must be the
-- caller's current account (profiles.account_id), so a user cannot
-- register a device against an account they are not a member of.
-- ============================================================

DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND account_id = (
      SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid()
    )
  );
