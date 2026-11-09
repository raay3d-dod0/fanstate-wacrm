import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Helpers for the Shopify "Order creation" webhook
 * (`/api/shopify/orders`): signature check, phone clean-up, and the
 * values that fill the `fanstate_order_confirmed` WhatsApp template.
 */

/** The subset of Shopify's order JSON this CRM reads. */
export interface ShopifyAddress {
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
}

export interface ShopifyLineItem {
  title?: string | null
  variant_title?: string | null
  quantity?: number | null
  current_quantity?: number | null
}

export interface ShopifyOrder {
  id: number
  name?: string | null
  email?: string | null
  contact_email?: string | null
  phone?: string | null
  created_at?: string | null
  currency?: string | null
  total_price?: string | null
  current_total_price?: string | null
  customer?: (ShopifyAddress & { default_address?: ShopifyAddress | null }) | null
  billing_address?: ShopifyAddress | null
  shipping_address?: ShopifyAddress | null
  line_items?: ShopifyLineItem[] | null
}

/**
 * Shopify signs each webhook with HMAC-SHA256 over the raw body using
 * the store's webhook signing key, base64-encoded in
 * `X-Shopify-Hmac-Sha256`.
 */
export function verifyShopifyHmac(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!header || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let given: Buffer
  try {
    given = Buffer.from(header, 'base64')
  } catch {
    return false
  }
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Turns whatever the customer typed at checkout into `+<country><number>`.
 * Numbers without a country code are treated as Indian (the store sells
 * in India): `98765 43210`, `098765 43210` and `919876543210` all become
 * `+919876543210`. Returns null when it can't be a phone number.
 */
export function normalizeOrderPhone(
  raw: string | null | undefined,
  defaultCountryCode = '91',
): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('00')
  let digits = trimmed.replace(/\D/g, '')
  if (trimmed.startsWith('00')) digits = digits.slice(2)
  if (!digits) return null

  if (!hasPlus) {
    if (digits.length === 11 && digits.startsWith('0')) {
      digits = defaultCountryCode + digits.slice(1)
    } else if (digits.length === 10) {
      digits = defaultCountryCode + digits
    }
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null
  return `+${digits}`
}

/** First usable phone on the order, in the order Shopify fills them. */
export function pickOrderPhone(order: ShopifyOrder): string | null {
  const candidates = [
    order.phone,
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.customer?.default_address?.phone,
  ]
  for (const c of candidates) {
    const p = normalizeOrderPhone(c)
    if (p) return p
  }
  return null
}

export function pickFirstName(order: ShopifyOrder): string | null {
  const names = [
    order.customer?.first_name,
    order.shipping_address?.first_name,
    order.billing_address?.first_name,
  ]
  for (const n of names) {
    const v = n?.trim()
    if (v) return v
  }
  return null
}

export function pickFullName(order: ShopifyOrder): string | null {
  for (const a of [order.customer, order.shipping_address, order.billing_address]) {
    const v = [a?.first_name, a?.last_name].filter((s) => s && s.trim()).join(' ').trim()
    if (v) return v
  }
  return null
}

/**
 * WhatsApp rejects template values containing new lines, tabs or more
 * than four spaces in a row, so every value is flattened.
 */
export function cleanTemplateValue(value: string, max = 200): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function describeLineItems(items: ShopifyLineItem[] | null | undefined): string {
  const parts: string[] = []
  for (const item of items ?? []) {
    const qty = item.current_quantity ?? item.quantity ?? 0
    if (!qty || !item.title) continue
    const variant =
      item.variant_title && item.variant_title !== 'Default Title' ? ` (${item.variant_title})` : ''
    parts.push(`${item.title}${variant} x${qty}`)
  }
  return parts.join(', ')
}

export function formatOrderTotal(amount: string | null | undefined, currency: string | null | undefined): string {
  const value = Number(amount ?? '0')
  const code = (currency || 'INR').toUpperCase()
  const whole = Number.isInteger(value)
  try {
    const formatted = new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value)
    return formatted
  } catch {
    return `${code} ${value.toFixed(2)}`
  }
}

/** Body values for `fanstate_order_confirmed`: name, order, items, total. */
export function orderConfirmedParams(order: ShopifyOrder): string[] {
  const total = order.current_total_price ?? order.total_price
  return [
    cleanTemplateValue(pickFirstName(order) ?? 'there', 60),
    cleanTemplateValue(order.name ?? `#${order.id}`, 40),
    cleanTemplateValue(describeLineItems(order.line_items) || 'Your Fanstate order', 400),
    cleanTemplateValue(formatOrderTotal(total, order.currency), 40),
  ]
}
