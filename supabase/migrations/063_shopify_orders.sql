-- ============================================================
-- 063_shopify_orders.sql
--
-- One row per Shopify order received on /api/shopify/orders. It is
-- the "already handled" record so Shopify's webhook retries never send
-- the customer a second "Order confirmed" WhatsApp, and it keeps the
-- order details the CRM needs later (Meta purchase events).
--
-- Written only by the webhook route with the service role. Account
-- members can read their own account's rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS shopify_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shopify_order_id BIGINT NOT NULL,
  order_name TEXT,
  customer_name TEXT,
  phone TEXT,
  email TEXT,
  total NUMERIC(12, 2),
  currency TEXT,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  shopify_created_at TIMESTAMPTZ,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- received | sent | skipped | failed
  whatsapp_status TEXT NOT NULL DEFAULT 'received',
  whatsapp_message_id TEXT,
  whatsapp_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_account_created
  ON shopify_orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_contact
  ON shopify_orders(contact_id);

ALTER TABLE shopify_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_orders_select ON shopify_orders;
CREATE POLICY shopify_orders_select ON shopify_orders FOR SELECT
  USING (is_account_member(account_id));
