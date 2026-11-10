import type { SupabaseClient } from '@supabase/supabase-js'

import { shopifyAdminConfigured, shopifyGraphql } from '@/lib/shopify/admin'
import { cleanTemplateValue, formatOrderTotal, normalizeOrderPhone } from '@/lib/shopify/orders'
import { decrypt } from '@/lib/whatsapp/encryption'
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
 * Plain "checkout not completed" notice submitted as UTILITY (founder
 * 2026-11-10, after Meta's marketing limit, error 131049, dropped the
 * marketing reminder). Used only while Meta has it APPROVED *and* still
 * in the UTILITY category; if Meta moves it to marketing we fall back to
 * the marketing reminder. Body: {{1}} first name, {{2}} items, {{3}}
 * amount; its one URL button is `https://fanstate.shop/{{1}}`.
 */
export const UTILITY_TEMPLATE_NAME = 'fanstate_checkout_pending'
const UTILITY_URL_BUTTON_INDEX = 0
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
/** A retry may go out up to this long after the cart was made. */
const MAX_RETRY_CART_AGE_MS = 72 * 60 * 60 * 1000
/**
 * Statuses that mean a reminder already went out for the cart.
 * `reminded`: first send done (a retry may still follow);
 * `retried`: the one next-day retry went out; `reminder_done`: checked
 * for a retry and none was needed.
 */
export const REMINDED_STATUSES = ['reminded', 'retried', 'reminder_done']
/** Meta's per-user marketing limit ("healthy ecosystem engagement"). */
const META_PER_USER_LIMIT = '131049'

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

/** "₹1,199" from Fastrr's total_price + currency. */
export function cartAmount(payload: Json): string {
  const raw = payload.total_price
  const amount = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '0'
  return formatOrderTotal(amount, str(payload.currency) ?? 'INR')
}

interface WaConfig {
  wabaId: string
  accessToken: string
}

async function waConfig(db: SupabaseClient, accountId: string): Promise<WaConfig> {
  const { data } = await db.from('whatsapp_config').select('waba_id, access_token').eq('account_id', accountId).single()
  const row = data as { waba_id?: string; access_token?: string } | null
  if (!row?.waba_id || !row.access_token) throw new Error('WhatsApp is not configured')
  return { wabaId: row.waba_id, accessToken: decrypt(row.access_token) }
}

/**
 * The template's status and category as Meta has them right now. Our
 * own table is only refreshed by a manual sync, and Meta can move a
 * utility template to marketing at any time.
 */
async function liveTemplate(
  config: WaConfig,
  name: string,
): Promise<{ status: string; category: string } | null> {
  const url = new URL(`https://graph.facebook.com/v21.0/${config.wabaId}/message_templates`)
  url.searchParams.set('name', name)
  url.searchParams.set('fields', 'name,language,status,category')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` } })
  if (!res.ok) throw new Error(`Could not read template ${name} from Meta (${res.status})`)
  const body = (await res.json()) as { data?: Array<{ name: string; language: string; status: string; category: string }> }
  const t = (body.data ?? []).find((x) => x.name === name && x.language === CART_TEMPLATE_LANGUAGE)
  return t ? { status: String(t.status).toUpperCase(), category: String(t.category).toUpperCase() } : null
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
  reminded_at?: string | null
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

/** Was the first reminder in this chat dropped by Meta's per-user limit? */
async function firstSendBlocked(db: SupabaseClient, conversationId: string, remindedAt: string): Promise<boolean> {
  const at = new Date(remindedAt).getTime()
  const { data } = await db
    .from('messages')
    .select('status, error_code')
    .eq('conversation_id', conversationId)
    .in('template_name', [CART_TEMPLATE_NAME, UTILITY_TEMPLATE_NAME])
    .gte('created_at', new Date(at - 10 * 60 * 1000).toISOString())
    .lte('created_at', new Date(at + 10 * 60 * 1000).toISOString())
  const rows = (data ?? []) as Array<{ status: string | null; error_code: string | number | null }>
  return rows.length > 0 && rows.every((m) => m.status === 'failed' && String(m.error_code) === META_PER_USER_LIMIT)
}

/**
 * Decide and send for one stored cart. The row is claimed first
 * (received → sending, or reminded → sending for a retry) so a
 * duplicate webhook or a re-run can never send twice.
 *
 * `retry`: the one next-day attempt, only for a cart whose first
 * reminder Meta dropped with 131049, at least 24 h later (Meta: wait at
 * least 24 hours; sooner can lock the person out for another 24 h).
 */
export async function remindCart(
  db: SupabaseClient,
  row: CartRow,
  now = new Date(),
  mode: 'first' | 'retry' = 'first',
): Promise<ReminderOutcome> {
  const retry = mode === 'retry'
  const { data: claimed } = await db
    .from('fastrr_abandoned_carts')
    .update({ status: 'sending', error: null })
    .eq('id', row.id)
    .eq('status', retry ? 'reminded' : 'received')
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped', reason: 'Already handled' }

  const finish = async (outcome: ReminderOutcome) => {
    await db
      .from('fastrr_abandoned_carts')
      .update(
        outcome.status === 'reminded'
          ? { status: retry ? 'retried' : 'reminded', reminded_at: new Date().toISOString(), error: null }
          : { status: retry && outcome.status === 'skipped' ? 'reminder_done' : outcome.status, error: outcome.reason },
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
    if (now.getTime() - createdAt.getTime() > (retry ? MAX_RETRY_CART_AGE_MS : MAX_CART_AGE_MS)) {
      return finish({ status: 'skipped', reason: retry ? 'Cart too old for a retry' : 'Cart older than 48 hours' })
    }
    if (retry && (!row.reminded_at || now.getTime() - new Date(row.reminded_at).getTime() < PER_PHONE_GAP_MS)) {
      // Too early: put it back untouched for the next run.
      await db.from('fastrr_abandoned_carts').update({ status: 'reminded' }).eq('id', row.id)
      return { status: 'skipped', reason: 'Less than 24 hours since the first reminder' }
    }

    // One reminder per cart (the retry is this cart's second try).
    if (row.cart_id && !retry) {
      const { count } = await db
        .from('fastrr_abandoned_carts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', row.account_id)
        .eq('cart_id', row.cart_id)
        .in('status', REMINDED_STATUSES)
      if ((count ?? 0) > 0) return finish({ status: 'skipped', reason: 'This cart was already reminded' })
    }

    // At most one reminder per phone number a day.
    const { data: recent } = await db
      .from('fastrr_abandoned_carts')
      .select('id, phone, payload')
      .eq('account_id', row.account_id)
      .in('status', REMINDED_STATUSES)
      .gte('reminded_at', new Date(now.getTime() - PER_PHONE_GAP_MS).toISOString())
    const remindedToday = ((recent ?? []) as Array<{ id: string; phone: string | null; payload: Json }>).some(
      (r) => r.id !== row.id && cartPhone(r.payload ?? {}, r.phone) === phone,
    )
    if (remindedToday) return finish({ status: 'skipped', reason: 'Number already reminded in the last 24 hours' })

    if (await orderedSince(phone, cartEmail(payload), createdAt)) {
      return finish({ status: 'recovered', reason: 'Shopper already ordered' })
    }

    const config = await waConfig(db, row.account_id)
    const utility = await liveTemplate(config, UTILITY_TEMPLATE_NAME)
    const useUtility = utility?.status === 'APPROVED' && utility.category === 'UTILITY'
    if (!useUtility) {
      const marketing = await liveTemplate(config, CART_TEMPLATE_NAME)
      if (marketing?.status !== 'APPROVED') {
        // Put it back so it can be sent once Meta approves a template.
        await db
          .from('fastrr_abandoned_carts')
          .update({ status: retry ? 'reminded' : 'received', error: 'No approved reminder template yet' })
          .eq('id', row.id)
        return { status: 'skipped', reason: 'Template not approved yet' }
      }
    }

    const ship = (payload.shipping_address ?? {}) as Json
    const fullName = [str(payload.first_name), str(payload.last_name)].filter(Boolean).join(' ') || str(ship.name)
    const { conversationId } = await resolveConversationByPhone(db, row.account_id, phone, fullName)

    if (await optedOut(db, conversationId)) {
      return finish({ status: 'skipped', reason: 'Shopper asked us to stop' })
    }
    if (retry && !(await firstSendBlocked(db, conversationId, row.reminded_at!))) {
      return finish({ status: 'skipped', reason: 'First reminder was not blocked by Meta' })
    }

    const firstName = cleanTemplateValue(cartFirstName(payload), 60)
    const items = cleanTemplateValue(describeCartItems(payload), 120)
    const suffix = cartResumeSuffix(resumeId)
    const image = cartImageUrl(payload)
    const result = useUtility
      ? await sendMessageToConversation(db, row.account_id, {
          conversationId,
          messageType: 'template',
          templateName: UTILITY_TEMPLATE_NAME,
          templateLanguage: CART_TEMPLATE_LANGUAGE,
          templateMessageParams: {
            body: [firstName, items, cleanTemplateValue(cartAmount(payload), 40)],
            buttonParams: { [UTILITY_URL_BUTTON_INDEX]: suffix },
          },
        })
      : await sendMessageToConversation(db, row.account_id, {
          conversationId,
          messageType: 'template',
          templateName: CART_TEMPLATE_NAME,
          templateLanguage: CART_TEMPLATE_LANGUAGE,
          marketingApi: true,
          templateMessageParams: {
            body: [firstName, items],
            ...(image ? { headerMediaUrl: image } : {}),
            buttonParams: { [CART_URL_BUTTON_INDEX]: suffix },
          },
        })
    return finish({ status: 'reminded', messageId: result.whatsappMessageId })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.from('fastrr_abandoned_carts').update({ status: 'failed', error: message.slice(0, 500) }).eq('id', row.id)
    return { status: 'skipped', reason: message }
  }
}
