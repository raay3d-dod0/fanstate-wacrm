-- ============================================================
-- 065_flow_nodes_order_lookup.sql
--
-- Allow the new 'order_lookup' flow step (Shopify "Track my order"
-- lookup). Same list as 016 plus order_lookup; widening a CHECK is safe
-- for existing rows.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'order_lookup',
    'handoff',
    'http_fetch',
    'end'
  ));
