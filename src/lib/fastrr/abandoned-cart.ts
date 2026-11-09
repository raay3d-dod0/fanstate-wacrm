import { timingSafeEqual } from 'node:crypto'

/**
 * Helpers for the Fastrr (Shiprocket Checkout) abandoned-cart webhook.
 *
 * Fastrr's payload format isn't publicly documented, so step 1 stores
 * the raw payload and pulls out the obvious fields by searching common
 * key names at any depth. The reminder flow is built once real payloads
 * have been seen.
 */

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Fastrr's webhook form lets the merchant add a header; integrations
 * use either `Authorization: Bearer <key>` or a custom header such as
 * `key: <key>`. Accept those, `x-api-key`, or `?key=` on the URL.
 */
export function fastrrRequestAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false
  const h = request.headers
  const candidates: string[] = []
  const auth = h.get('authorization')
  if (auth) candidates.push(auth.replace(/^Bearer\s+/i, '').trim())
  for (const name of ['key', 'x-api-key', 'x-webhook-key', 'x-fastrr-key']) {
    const v = h.get(name)
    if (v) candidates.push(v.trim())
  }
  const q = new URL(request.url).searchParams.get('key')
  if (q) candidates.push(q.trim())
  return candidates.some((c) => safeEqual(c, secret))
}

type Json = unknown

/** First string/number value found for any of `keys`, at any depth. */
export function findField(obj: Json, keys: string[], depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  const want = keys.map((k) => k.toLowerCase())
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v] as const) : Object.entries(obj)
  for (const [k, v] of entries) {
    if (want.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) {
      return String(v).trim()
    }
  }
  for (const [, v] of entries) {
    const found = findField(v, keys, depth + 1)
    if (found) return found
  }
  return null
}

/** First http(s) URL that looks like a checkout / cart link, at any depth. */
export function findCheckoutUrl(obj: Json, depth = 0): string | null {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && /(checkout|cart|recover)/i.test(v)) return v
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findCheckoutUrl(v, depth + 1)
    if (found) return found
  }
  return null
}

export interface ParsedCart {
  cartId: string | null
  phone: string | null
  customerName: string | null
  email: string | null
  total: number | null
  checkoutUrl: string | null
}

export function parseAbandonedCart(payload: Json): ParsedCart {
  const total = findField(payload, ['total_price', 'cart_value', 'total', 'grand_total', 'amount', 'subtotal_price'])
  const first = findField(payload, ['first_name', 'firstname'])
  const last = findField(payload, ['last_name', 'lastname'])
  return {
    cartId: findField(payload, ['cart_id', 'cartid', 'checkout_id', 'token', 'cart_token', 'id']),
    phone: findField(payload, ['phone', 'phone_number', 'mobile', 'mobile_number', 'contact', 'contact_number']),
    customerName:
      findField(payload, ['customer_name', 'name', 'full_name']) ??
      ([first, last].filter(Boolean).join(' ') || null),
    email: findField(payload, ['email', 'email_id', 'customer_email']),
    total: total && Number.isFinite(Number(total)) ? Number(total) : null,
    checkoutUrl: findCheckoutUrl(payload),
  }
}
