import type { SupabaseClient } from '@supabase/supabase-js'

import { shopifyAdminConfigured, shopifyGraphql } from '@/lib/shopify/admin'
import { cleanTemplateValue, normalizeOrderPhone } from '@/lib/shopify/orders'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

/**
 * Abandoned-cart WhatsApp reminder (step 2).
 *
 * Fastrr already waits (the webhook's delay setting) before it reports a
 * cart, so the reminder goes out as soon as the cart arrives. One
 * reminder per cart, at most one per phone number a day, never when the
 * shopper has already ordered, never after they replied STOP.
 */

export const CART_TEMPLATE_NAME = 'fanstate_cart_reminder'
export const CART_TEMPLATE_LANGUAGE = 'en'
/**
 * The approved template's buttons: 0 "I have a question", 1 "Stop
 * reminders" (quick replies), 2 "Complete my order" with the URL
 * `https://fanstate.shop/{{1}}`; {{1}} is the cart-resume suffix.
 */
export const CART_URL_BUTTON_INDEX = 2
export function cartResumeSuffix(resumeId: string): string {
  return `?cart-resume-id=${resumeId}`
}
/** Carts older than this when we get to them are not worth a reminder. */
const MAX_CART_AGE_MS = 48 * 60 * 60 * 1000
const PER_PHONE_GAP_MS = 24 * 60 * 60 * 1000

const STORE_HOSTS = new Set(['fanstate.shop', 'www.fanstate.shop'])
const IMAGE_HOSTS = new Set(['cdn.shopify.com'])

type Json = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Cart resume id from a Fastrr checkout link on our own store, else null. */
export function resumeIdFromCheckoutUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !STORE_HOSTS.has(u.hostname)) return null
    const id = u.searchParams.get('cart-resume-id')
    return id && /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Product picture for the message header, only from Shopify's CDN. */
export function cartImageUrl(payload: Json): string | null {
  const items = Array.isArray(payload.items) ? (payload.items as Json[]) : []
  for (const candidate of [str(items[0]?.img_url), str(payload.img_url)]) {
    if (!candidate) continue
    try {
      const u = new URL(candidate)
      if (u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname)) return u.toString()
    } catch {
      /* not a URL */
    }
  }
  return null
}

/** "Agumbe Ghat - Black / A4", or "Agumbe Ghat - Black / A4 and 1 more frame". */
export function describeCartItems(payload: Json): string {
  const items = Array.isArray(payload.items) ? (payload.items as Json[]) : []
  const titles = items.map((i) => str(i.title) ?? str(i.name)).filter((t): t is string => Boolean(t))
  if (titles.length === 0) {
    const list = Array.isArray(payload.item_title_list) ? payload.item_title_list : []
    titles.push(...list.map(str).filter((t): t is string => Boolean(t)))
  }
  if (titles.length === 0) return 'Fanstate frame'
  const more = titles.length - 1
  return more > 0 ? `${titles[0]} and ${more} more ${more === 1 ? 'item' : 'items'}` : titles[0]
}

export function cartFirstName(payload: Json): string {
  const ship = (payload.shipping_address ?? {}) as Json
  const bill = (payload.billing_address ?? {}) as Json
  return str(payload.first_name) ?? str(ship.first_name) ?? str(bill.first_name) ?? 'there'
}

export function cartPhone(payload: Json, stored: string | null): string | null {
  const ship = (payload.shipping_address ?? {}) as Json
  const bill = (payload.billing_address ?? {}) as Json
  for (const raw of [str(payload.phone_number), str(ship.phone), str(bill.phone), stored]) {
    const p = normalizeOrderPhone(raw)
    if (p) return p
  }
  return null
}

export function cartEmail(payload: Json): string | null {
  return str(payload.email)?.toLowerCase() ?? null
}

/** Fastrr's created_at has no zone; it is India time. */
export function cartCreatedAt(payload: Json, receivedAt: string): Date {
  const raw = str(payload.created_at)
  if (raw) {
    const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}+05:30`
    const d = new Date(withZone)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date(receivedAt)
}

export interface CartRow {
  id: string
  account_id: string
  cart_id: string | null
  phone: string | null
  checkout_url: string | null
  status: string
  payload: Json
  received_at: string
}

export type ReminderOutcome =
  | { status: 'reminded'; messageId: string }
  | { status: 'recovered' | 'skipped'; reason: string }

interface OrderNode {
  createdAt: string
  email: string | null
  phone: string | null
  shippingAddress: { phone: string | null } | null
  billingAddress: { phone: string | null } | null
}

const RECENT_ORDERS_QUERY = `
  query RecentOrders($q: String!) {
    orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { createdAt email phone shippingAddress { phone } billingAddress { phone } }
    }
  }
`

/** Has this shopper placed a Shopify order since the cart was made? */
export async function orderedSince(phone: string, email: string | null, since: Date): Promise<boolean> {
  if (!shopifyAdminConfigured()) throw new Error('Shopify admin is not configured')
  const from = new Date(since.getTime() - 10 * 60 * 1000).toISOString()
  const data = await shopifyGraphql<{ orders: { nodes: OrderNode[] } }>(RECENT_ORDERS_QUERY, {
    q: `created_at:>='${from}'`,
  })
  return data.orders.nodes.some((o) => {
    const phones = [o.phone, o.shippingAddress?.phone, o.billingAddress?.phone].map((p) => normalizeOrderPhone(p))
    if (phones.includes(phone)) return true
    return Boolean(email && o.email && o.email.trim().toLowerCase() === email)
  })
}

/** Did this number ever write STOP to us? */
async function optedOut(db: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(200)
  return ((data ?? []) as Array<{ content_text: string | null }>).some((m) =>
    /^\s*(stop|stop reminders|unsubscribe)\s*[.!]?\s*$/i.test(m.content_text ?? ''),
  )
}

/**
 * Decide and send for one stored cart. The row is claimed first
 * (received → sending) so a duplicate webhook or a manual re-run can
 * never send twice.
 */
export async function remindCart(db: SupabaseClient, row: CartRow, now = new Date()): Promise<ReminderOutcome> {
  const { data: claimed } = await db
    .from('fastrr_abandoned_carts')
    .update({ status: 'sending', error: null })
    .eq('id', row.id)
    .eq('status', 'received')
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped', reason: 'Already handled' }

  const finish = async (outcome: ReminderOutcome) => {
    await db
      .from('fastrr_abandoned_carts')
      .update(
        outcome.status === 'reminded'
          ? { status: 'reminded', reminded_at: new Date().toISOString(), error: null }
          : { status: outcome.status, error: outcome.reason },
      )
      .eq('id', row.id)
    return outcome
  }

  try {
    const payload = (row.payload ?? {}) as Json
    const phone = cartPhone(payload, row.phone)
    if (!phone) return finish({ status: 'skipped', reason: 'No usable phone number' })

    const resumeId = resumeIdFromCheckoutUrl(row.checkout_url ?? str(payload.checkout_url))
    if (!resumeId) return finish({ status: 'skipped', reason: 'Checkout link is not on fanstate.shop' })

    const createdAt = cartCreatedAt(payload, row.received_at)
    if (now.getTime() - createdAt.getTime() > MAX_CART_AGE_MS) {
      return finish({ status: 'skipped', reason: 'Cart older than 48 hours' })
    }

    // One reminder per cart.
    if (row.cart_id) {
      const { count } = await db
        .from('fastrr_abandoned_carts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', row.account_id)
        .eq('cart_id', row.cart_id)
        .eq('status', 'reminded')
      if ((count ?? 0) > 0) return finish({ status: 'skipped', reason: 'This cart was already reminded' })
    }

    // At most one reminder per phone number a day.
    const { data: recent } = await db
      .from('fastrr_abandoned_carts')
      .select('phone, payload')
      .eq('account_id', row.account_id)
      .eq('status', 'reminded')
      .gte('reminded_at', new Date(now.getTime() - PER_PHONE_GAP_MS).toISOString())
    const remindedToday = ((recent ?? []) as Array<{ phone: string | null; payload: Json }>).some(
      (r) => cartPhone(r.payload ?? {}, r.phone) === phone,
    )
    if (remindedToday) return finish({ status: 'skipped', reason: 'Number already reminded in the last 24 hours' })

    if (await orderedSince(phone, cartEmail(payload), createdAt)) {
      return finish({ status: 'recovered', reason: 'Shopper already ordered' })
    }

    const { data: template } = await db
      .from('message_templates')
      .select('status')
      .eq('account_id', row.account_id)
      .eq('name', CART_TEMPLATE_NAME)
      .eq('language', CART_TEMPLATE_LANGUAGE)
      .maybeSingle()
    if ((template as { status?: string } | null)?.status !== 'APPROVED') {
      // Put it back so it can be sent once Meta approves the template.
      await db.from('fastrr_abandoned_carts').update({ status: 'received', error: `Template ${CART_TEMPLATE_NAME} is not approved yet` }).eq('id', row.id)
      return { status: 'skipped', reason: 'Template not approved yet' }
    }

    const ship = (payload.shipping_address ?? {}) as Json
    const fullName = [str(payload.first_name), str(payload.last_name)].filter(Boolean).join(' ') || str(ship.name)
    const { conversationId } = await resolveConversationByPhone(db, row.account_id, phone, fullName)

    if (await optedOut(db, conversationId)) {
      return finish({ status: 'skipped', reason: 'Shopper asked us to stop' })
    }

    const image = cartImageUrl(payload)
    const result = await sendMessageToConversation(db, row.account_id, {
      conversationId,
      messageType: 'template',
      templateName: CART_TEMPLATE_NAME,
      templateLanguage: CART_TEMPLATE_LANGUAGE,
      templateMessageParams: {
        body: [cleanTemplateValue(cartFirstName(payload), 60), cleanTemplateValue(describeCartItems(payload), 120)],
        ...(image ? { headerMediaUrl: image } : {}),
        buttonParams: { [CART_URL_BUTTON_INDEX]: cartResumeSuffix(resumeId) },
      },
    })
    return finish({ status: 'reminded', messageId: result.whatsappMessageId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.from('fastrr_abandoned_carts').update({ status: 'failed', error: message.slice(0, 500) }).eq('id', row.id)
    return { status: 'skipped', reason: message }
  }
}
