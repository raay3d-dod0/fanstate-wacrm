-- ============================================================
-- 066_shopify_orders_meta.sql
--
-- Record whether each Shopify order's Purchase reached Meta's
-- Conversions API, and whether the buyer had chatted on WhatsApp
-- before ordering (sent to Meta as order_channel = whatsapp_chat).
-- ============================================================

ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS meta_status TEXT,
  ADD COLUMN IF NOT EXISTS meta_error TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_chat BOOLEAN NOT NULL DEFAULT false;
