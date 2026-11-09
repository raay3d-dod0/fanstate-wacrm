-- ============================================================
-- 067_fastrr_abandoned_carts.sql
--
-- Abandoned carts pushed by the Fastrr (Shiprocket Checkout) webhook to
-- /api/fastrr/abandoned-cart. The store's checkout runs on Fastrr, so
-- Shopify never sees these carts; Fastrr is the only source. Step 1
-- stores every payload as received (raw) so the reminder flow can be
-- built on the real shape; the parsed columns are best-effort.
--
-- Written only by the webhook route with the service role. Account
-- members can read their own account's rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS fastrr_abandoned_carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cart_id TEXT,
  phone TEXT,
  customer_name TEXT,
  email TEXT,
  total NUMERIC(12, 2),
  checkout_url TEXT,
  payload JSONB NOT NULL,
  -- received | reminded | recovered | skipped
  status TEXT NOT NULL DEFAULT 'received',
  reminded_at TIMESTAMPTZ,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fastrr_carts_account_received
  ON fastrr_abandoned_carts(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_fastrr_carts_cart
  ON fastrr_abandoned_carts(account_id, cart_id);

ALTER TABLE fastrr_abandoned_carts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fastrr_abandoned_carts_select ON fastrr_abandoned_carts;
CREATE POLICY fastrr_abandoned_carts_select ON fastrr_abandoned_carts FOR SELECT
  USING (is_account_member(account_id));
