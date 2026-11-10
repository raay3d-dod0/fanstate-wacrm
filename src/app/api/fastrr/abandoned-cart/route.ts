import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fastrrRequestAuthorized, parseAbandonedCart } from '@/lib/fastrr/abandoned-cart'
import { remindCart, type CartRow } from '@/lib/fastrr/cart-reminder'

/**
 * Fastrr (Shiprocket Checkout) → "Abandoned Cart" webhook.
 *
 * Fastrr dashboard → Settings → Webhooks → add this URL with the event
 * "Abandoned Cart" and FASTRR_WEBHOOK_KEY as the key header. Every
 * cart is stored, then the WhatsApp reminder is sent in `after()` (see
 * lib/fastrr/cart-reminder). SHOPIFY_ACCOUNT_ID is the CRM account the
 * store belongs to.
 */
export const maxDuration = 60

const MAX_BODY_BYTES = 500_000

export async function POST(request: Request) {
  const secret = process.env.FASTRR_WEBHOOK_KEY
  const accountId = process.env.SHOPIFY_ACCOUNT_ID
  if (!secret || !accountId) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!fastrrRequestAuthorized(request, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  let payload: unknown
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const cart = parseAbandonedCart(payload)
  const db = supabaseAdmin()
  const { data: row, error } = await db
    .from('fastrr_abandoned_carts')
    .insert({
      account_id: accountId,
      cart_id: cart.cartId,
      phone: cart.phone,
      customer_name: cart.customerName,
      email: cart.email,
      total: cart.total,
      checkout_url: cart.checkoutUrl,
      payload: payload ?? {},
    })
    .select('id, account_id, cart_id, phone, checkout_url, status, payload, received_at')
    .single()
  if (error) {
    console.error('[fastrr-cart] could not store cart', error.message)
    return NextResponse.json({ error: 'Could not store cart' }, { status: 500 })
  }
  after(async () => {
    const outcome = await remindCart(db, row as CartRow)
    console.log('[fastrr-cart] reminder', (row as CartRow).id, outcome.status, 'reason' in outcome ? outcome.reason : '')
  })
  return NextResponse.json({ status: 'received' }, { status: 200 })
}
