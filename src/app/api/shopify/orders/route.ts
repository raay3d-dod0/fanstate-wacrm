import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { buildPurchaseEvent, metaCapiConfigured, sendCapiEvents } from '@/lib/meta/capi'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  verifyShopifyHmac,
  pickOrderPhone,
  pickFullName,
  orderConfirmedParams,
  type ShopifyOrder,
} from '@/lib/shopify/orders'

/**
 * Shopify "Order creation" webhook → "Order confirmed" WhatsApp.
 *
 * Shopify admin → Settings → Notifications → Webhooks → Order creation
 * (JSON) points here. The signing key shown on that page goes in
 * SHOPIFY_WEBHOOK_SECRET; SHOPIFY_ACCOUNT_ID is the CRM account the
 * orders belong to.
 *
 * Shopify retries anything that isn't a 2xx within 5 s, so we verify,
 * record the order (the unique key makes retries no-ops) and reply 200;
 * the WhatsApp send runs in `after()` like the Meta webhook does.
 */
export const maxDuration = 60

const TEMPLATE_NAME = 'fanstate_order_confirmed'
const TEMPLATE_LANGUAGE = 'en'
const MAX_BODY_BYTES = 1_000_000

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET
  const accountId = process.env.SHOPIFY_ACCOUNT_ID
  if (!secret || !accountId) {
    console.error('[shopify-orders] SHOPIFY_WEBHOOK_SECRET / SHOPIFY_ACCOUNT_ID not set')
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  if (!verifyShopifyHmac(rawBody, request.headers.get('x-shopify-hmac-sha256'), secret)) {
    console.warn('[shopify-orders] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const topic = request.headers.get('x-shopify-topic')
  if (topic && topic !== 'orders/create') {
    return NextResponse.json({ status: 'ignored', topic }, { status: 200 })
  }

  let order: ShopifyOrder
  try {
    order = JSON.parse(rawBody) as ShopifyOrder
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!order?.id) {
    return NextResponse.json({ error: 'Missing order id' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const phone = pickOrderPhone(order)
  const { data: inserted, error: insertErr } = await db
    .from('shopify_orders')
    .upsert(
      {
        account_id: accountId,
        shopify_order_id: order.id,
        order_name: order.name ?? null,
        customer_name: pickFullName(order),
        phone,
        email: order.email ?? order.contact_email ?? null,
        total: Number(order.current_total_price ?? order.total_price ?? 0),
        currency: order.currency ?? null,
        line_items: (order.line_items ?? []).map((li) => ({
          title: li.title ?? null,
          variant_title: li.variant_title ?? null,
          quantity: li.current_quantity ?? li.quantity ?? 0,
        })),
        shopify_created_at: order.created_at ?? null,
      },
      { onConflict: 'account_id,shopify_order_id', ignoreDuplicates: true },
    )
    .select('id')

  if (insertErr) {
    console.error('[shopify-orders] could not record order', order.id, insertErr.message)
    // 500 so Shopify retries later instead of the order being lost.
    return NextResponse.json({ error: 'Could not record order' }, { status: 500 })
  }
  if (!inserted || inserted.length === 0) {
    // A retry of an order we already have — never message twice.
    return NextResponse.json({ status: 'duplicate' }, { status: 200 })
  }

  const rowId = (inserted[0] as { id: string }).id
  after(async () => {
    // Meta first: it must see the buyer as they were before this order
    // (sending the WhatsApp creates the contact if it didn't exist).
    try {
      await sendPurchaseToMeta(rowId, accountId, order, phone)
    } catch (error) {
      console.error('[shopify-orders] Meta purchase failed', order.id, error)
    }
    try {
      await sendOrderConfirmed(rowId, accountId, order, phone)
    } catch (error) {
      console.error('[shopify-orders] send failed', order.id, error)
      await db
        .from('shopify_orders')
        .update({
          whatsapp_status: 'failed',
          whatsapp_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        })
        .eq('id', rowId)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function sendOrderConfirmed(
  rowId: string,
  accountId: string,
  order: ShopifyOrder,
  phone: string | null,
) {
  const db = supabaseAdmin()
  const mark = (patch: Record<string, unknown>) =>
    db
      .from('shopify_orders')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', rowId)

  if (!phone) {
    await mark({ whatsapp_status: 'skipped', whatsapp_error: 'No phone number on the order' })
    return
  }

  const { data: template } = await db
    .from('message_templates')
    .select('status')
    .eq('account_id', accountId)
    .eq('name', TEMPLATE_NAME)
    .eq('language', TEMPLATE_LANGUAGE)
    .maybeSingle()
  if ((template as { status?: string } | null)?.status !== 'APPROVED') {
    await mark({
      whatsapp_status: 'skipped',
      whatsapp_error: `Template ${TEMPLATE_NAME} is not approved yet`,
    })
    return
  }

  const { conversationId, contactId } = await resolveConversationByPhone(
    db,
    accountId,
    phone,
    pickFullName(order),
  )
  await mark({ contact_id: contactId, conversation_id: conversationId })

  const result = await sendMessageToConversation(db, accountId, {
    conversationId,
    messageType: 'template',
    templateName: TEMPLATE_NAME,
    templateLanguage: TEMPLATE_LANGUAGE,
    templateParams: orderConfirmedParams(order),
  })

  await mark({
    whatsapp_status: 'sent',
    whatsapp_message_id: result.whatsappMessageId,
    whatsapp_error: null,
  })
}

/**
 * Did this buyer message the shop on WhatsApp before ordering? Then the
 * order is tagged as a WhatsApp-chat sale in Meta (custom_data).
 */
async function hadWhatsappChatBefore(
  accountId: string,
  phone: string | null,
  orderCreatedAt: string | null | undefined,
): Promise<boolean> {
  if (!phone) return false
  const db = supabaseAdmin()
  const contact = await findExistingContact(db, accountId, phone.replace(/^\+/, ''))
  if (!contact) return false
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', (contact as { id: string }).id)
  const ids = ((convs ?? []) as Array<{ id: string }>).map((c) => c.id)
  if (ids.length === 0) return false
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in('conversation_id', ids)
    .eq('sender_type', 'customer')
    .lte('created_at', orderCreatedAt ?? new Date().toISOString())
  return (count ?? 0) > 0
}

async function sendPurchaseToMeta(
  rowId: string,
  accountId: string,
  order: ShopifyOrder,
  phone: string | null,
) {
  const db = supabaseAdmin()
  const mark = async (patch: Record<string, unknown>) => {
    const { error } = await db.from('shopify_orders').update(patch).eq('id', rowId)
    if (error) console.warn('[shopify-orders] could not record Meta status', error.message)
  }
  if (!metaCapiConfigured()) return
  const whatsappChat = await hadWhatsappChatBefore(accountId, phone, order.created_at).catch(() => false)
  const event = buildPurchaseEvent(order, { whatsappChat })
  if (!event) {
    await mark({ meta_status: 'skipped', meta_error: order.test ? 'Test order' : 'Order older than 7 days' })
    return
  }
  try {
    await sendCapiEvents([event])
    await mark({ meta_status: 'sent', meta_error: null, whatsapp_chat: whatsappChat })
  } catch (error) {
    await mark({ meta_status: 'failed', meta_error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
