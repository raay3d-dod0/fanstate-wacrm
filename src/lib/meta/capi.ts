import { createHash } from 'node:crypto'

import {
  normalizeOrderPhone,
  pickOrderPhone,
  type ShopifyAddress,
  type ShopifyOrder,
} from '@/lib/shopify/orders'

/**
 * Meta Conversions API: one Purchase per Shopify order.
 *
 * The store's checkout (Fastrr) bypasses Shopify's checkout, so the
 * Facebook & Instagram app never reports purchases. The CRM receives
 * every order on the Shopify webhook and sends the Purchase here, with
 * the customer's details hashed the way Meta requires. event_id is the
 * Shopify order id, so a retry (or any other sender using the same id)
 * is de-duplicated by Meta instead of counted twice.
 *
 * Env: META_DATASET_ID (pixel/dataset id), META_CAPI_TOKEN,
 * META_EVENT_SOURCE_URL (the shop's public URL), optional
 * META_CATALOG_COUNTRY (default IN) for catalogue content ids.
 */

const GRAPH_VERSION = 'v25.0'
const MAX_EVENT_AGE_S = 7 * 24 * 3600

export function metaCapiConfigured(): boolean {
  return Boolean(process.env.META_DATASET_ID && process.env.META_CAPI_TOKEN)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Meta normalisation: trim + lowercase, then SHA-256. Empty → undefined. */
function hashed(value: string | null | undefined, clean: (v: string) => string = (v) => v): string | undefined {
  if (!value) return undefined
  const v = clean(value.trim().toLowerCase())
  return v ? sha256(v) : undefined
}

const lettersOnly = (v: string) => v.replace(/[^\p{L}]/gu, '')
const noSpaces = (v: string) => v.replace(/\s+/g, '')

/** Facebook click id from the landing URL (`?fbclid=…`) → fbc cookie format. */
export function fbcFromLandingSite(landingSite: string | null | undefined, orderTimeMs: number): string | undefined {
  if (!landingSite) return undefined
  const m = landingSite.match(/[?&]fbclid=([^&#]+)/)
  return m ? `fb.1.${orderTimeMs}.${decodeURIComponent(m[1])}` : undefined
}

function noteAttr(order: ShopifyOrder, names: string[]): string | undefined {
  for (const a of order.note_attributes ?? []) {
    if (a?.name && names.includes(a.name.toLowerCase()) && a.value) return a.value
  }
  return undefined
}

export interface PurchaseExtras {
  /** True when the buyer had messaged the shop on WhatsApp before ordering. */
  whatsappChat?: boolean
}

/** Pure: build the Purchase event for one order. Null when it must not be sent. */
export function buildPurchaseEvent(
  order: ShopifyOrder,
  extras: PurchaseExtras = {},
  nowMs: number = Date.now(),
): Record<string, unknown> | null {
  if (order.test) return null
  const createdMs = order.created_at ? Date.parse(order.created_at) : nowMs
  const eventTime = Math.floor((Number.isFinite(createdMs) ? createdMs : nowMs) / 1000)
  if (nowMs / 1000 - eventTime > MAX_EVENT_AGE_S) return null

  const addr: ShopifyAddress =
    order.shipping_address ?? order.billing_address ?? order.customer?.default_address ?? {}
  const phone = pickOrderPhone(order) ?? normalizeOrderPhone(order.customer?.phone)
  const country = (addr.country_code ?? 'IN').toLowerCase()

  const userData: Record<string, unknown> = {
    em: hashed(order.email ?? order.contact_email),
    ph: phone ? sha256(phone.replace(/\D/g, '')) : undefined,
    fn: hashed(order.customer?.first_name ?? addr.first_name, lettersOnly),
    ln: hashed(order.customer?.last_name ?? addr.last_name, lettersOnly),
    ct: hashed(addr.city, lettersOnly),
    st: hashed(addr.province_code, lettersOnly),
    zp: hashed(addr.zip, noSpaces),
    country: sha256(country),
    external_id: order.customer?.id ? sha256(String(order.customer.id)) : undefined,
    client_ip_address: order.browser_ip ?? noteAttr(order, ['ipv4_address', 'ip_address', 'browser_ip']),
    client_user_agent: order.client_details?.user_agent ?? undefined,
    fbc:
      noteAttr(order, ['_fbc', 'fbc']) ??
      fbcFromLandingSite(order.landing_site ?? noteAttr(order, ['landing_page_url', 'landing_site']), createdMs),
    fbp: noteAttr(order, ['_fbp', 'fbp']),
  }
  for (const k of Object.keys(userData)) if (userData[k] === undefined) delete userData[k]

  const catalogCountry = (process.env.META_CATALOG_COUNTRY || 'IN').toUpperCase()
  const contents = (order.line_items ?? [])
    .filter((li) => li.product_id && (li.current_quantity ?? li.quantity ?? 0) > 0)
    .map((li) => ({
      id: li.variant_id
        ? `shopify_${catalogCountry}_${li.product_id}_${li.variant_id}`
        : `shopify_${catalogCountry}_${li.product_id}`,
      quantity: li.current_quantity ?? li.quantity ?? 1,
      item_price: Number(li.price ?? 0),
    }))

  const sourceUrl = process.env.META_EVENT_SOURCE_URL
  const value = Number(order.current_total_price ?? order.total_price ?? 0)

  return {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: `shopify_order_${order.id}`,
    action_source: 'website',
    ...(sourceUrl ? { event_source_url: sourceUrl } : {}),
    user_data: userData,
    custom_data: {
      currency: (order.currency || 'INR').toUpperCase(),
      value,
      order_id: order.name ?? String(order.id),
      content_type: 'product',
      contents,
      content_ids: contents.map((c) => c.id),
      num_items: contents.reduce((n, c) => n + c.quantity, 0),
      ...(extras.whatsappChat ? { order_channel: 'whatsapp_chat' } : {}),
    },
  }
}

export async function sendCapiEvents(events: Record<string, unknown>[]): Promise<{ events_received?: number }> {
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.META_DATASET_ID}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events, access_token: process.env.META_CAPI_TOKEN }),
    },
  )
  const json = (await res.json().catch(() => ({}))) as {
    events_received?: number
    error?: { message?: string; error_user_msg?: string }
  }
  if (!res.ok || json.error) {
    throw new Error(`Meta CAPI ${res.status}: ${json.error?.error_user_msg ?? json.error?.message ?? 'unknown error'}`)
  }
  return json
}
