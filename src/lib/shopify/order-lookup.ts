import { shopifyGraphql, shopifyAdminConfigured } from './admin'
import { normalizeOrderPhone } from './orders'

/**
 * Looks up a customer's order for the flow "Look up order" step and
 * writes a ready-to-send status line. Only answers when the order's
 * phone number matches the WhatsApp number asking, so nobody can read
 * someone else's order by guessing numbers.
 */

export type OrderLookupStatus =
  | 'confirmed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'not_found'
  | 'phone_mismatch'
  | 'invalid_number'
  | 'error'

export interface OrderLookupResult {
  status: OrderLookupStatus
  /** True when the reply can go to the customer without a person. */
  answered: boolean
  orderName: string | null
  reply: string | null
  trackingUrl: string | null
}

interface Tracking {
  company: string | null
  number: string | null
  url: string | null
}

interface Fulfillment {
  status: string | null
  displayStatus: string | null
  deliveredAt: string | null
  createdAt: string | null
  trackingInfo: Tracking[]
}

export interface LookupOrder {
  name: string
  cancelledAt: string | null
  displayFulfillmentStatus: string | null
  phone: string | null
  shippingAddress: { phone: string | null } | null
  billingAddress: { phone: string | null } | null
  fulfillments: Fulfillment[]
}

const ORDER_QUERY = `
  query OrderByName($q: String!) {
    orders(first: 1, query: $q) {
      nodes {
        name
        cancelledAt
        displayFulfillmentStatus
        phone
        shippingAddress { phone }
        billingAddress { phone }
        fulfillments(first: 5) {
          status
          displayStatus
          deliveredAt
          createdAt
          trackingInfo(first: 3) { company number url }
        }
      }
    }
  }
`

/** "#1003", "1003", "order no 1003" → "1003". */
export function parseOrderNumber(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/#?\s*(\d{3,10})/)
  return m ? m[1] : null
}

/** Contacts store the WhatsApp id: full international digits, no "+". */
function contactE164(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits.length >= 8 ? `+${digits}` : null
}

/**
 * Exact match on the full international number. Only the order side
 * gets the "no country code means India" treatment, because that is
 * where a customer types a bare 10-digit number at checkout.
 */
export function orderPhoneMatches(order: LookupOrder, contactPhone: string | null | undefined): boolean {
  const asking = contactE164(contactPhone)
  if (!asking) return false
  return [order.phone, order.shippingAddress?.phone, order.billingAddress?.phone].some(
    (p) => normalizeOrderPhone(p) === asking,
  )
}

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(
    new Date(iso),
  )
}

/** Pure: turn a found, phone-verified order into the customer reply. */
export function describeOrder(order: LookupOrder): OrderLookupResult {
  const base = { orderName: order.name, trackingUrl: null as string | null }
  if (order.cancelledAt) {
    return { ...base, status: 'cancelled', answered: false, reply: null }
  }
  const fulfillments = [...(order.fulfillments ?? [])]
    .filter((f) => f.status !== 'CANCELLED' && f.status !== 'ERROR' && f.status !== 'FAILURE')
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  const latest = fulfillments[0]

  if (latest && (latest.deliveredAt || latest.displayStatus === 'DELIVERED')) {
    const when = latest.deliveredAt ? ` on ${formatDay(latest.deliveredAt)}` : ''
    return {
      ...base,
      status: 'delivered',
      answered: true,
      reply: `Good news! Order ${order.name} was delivered${when}. Enjoy your frame 🏁`,
    }
  }

  if (latest) {
    const t = latest.trackingInfo?.[0]
    const lines = [`Order ${order.name} has shipped 🚚`]
    if (t?.company) lines.push(`Courier: ${t.company}`)
    if (t?.number) lines.push(`Tracking number: ${t.number}`)
    if (t?.url) lines.push(`Track it here: ${t.url}`)
    if (latest.displayStatus === 'OUT_FOR_DELIVERY') lines[0] = `Order ${order.name} is out for delivery today 🚚`
    return { ...base, status: 'shipped', answered: true, reply: lines.join('\n'), trackingUrl: t?.url ?? null }
  }

  return {
    ...base,
    status: 'confirmed',
    answered: true,
    reply: `Order ${order.name} is confirmed ✅ We're preparing it now, and we'll send your tracking link here on WhatsApp as soon as it ships.`,
  }
}

/**
 * The Shopify credentials are one store's, so only the CRM account that
 * owns that store (SHOPIFY_ACCOUNT_ID) may look orders up. Every other
 * account fails closed.
 */
export function accountMayLookUpOrders(accountId: string | null | undefined): boolean {
  const owner = process.env.SHOPIFY_ACCOUNT_ID
  return Boolean(owner && accountId && owner === accountId)
}

export async function lookupOrderForContact(
  orderText: string | null | undefined,
  contactPhone: string | null | undefined,
  accountId: string | null | undefined,
): Promise<OrderLookupResult> {
  const empty = { answered: false, reply: null, trackingUrl: null }
  if (!accountMayLookUpOrders(accountId)) return { ...empty, status: 'error', orderName: null }
  const number = parseOrderNumber(orderText)
  if (!number) return { ...empty, status: 'invalid_number', orderName: null }
  if (!shopifyAdminConfigured()) return { ...empty, status: 'error', orderName: null }

  try {
    const data = await shopifyGraphql<{ orders: { nodes: LookupOrder[] } }>(ORDER_QUERY, {
      q: `name:#${number}`,
    })
    const order = data.orders.nodes[0]
    if (!order) return { ...empty, status: 'not_found', orderName: null }
    if (!orderPhoneMatches(order, contactPhone)) {
      return { ...empty, status: 'phone_mismatch', orderName: null }
    }
    return describeOrder(order)
  } catch (err) {
    console.error('[order-lookup] Shopify lookup failed', err)
    return { ...empty, status: 'error', orderName: null }
  }
}
