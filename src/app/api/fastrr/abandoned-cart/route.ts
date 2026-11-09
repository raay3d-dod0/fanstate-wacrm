import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fastrrRequestAuthorized, parseAbandonedCart } from '@/lib/fastrr/abandoned-cart'

/**
 * Fastrr (Shiprocket Checkout) → "Abandoned Cart" webhook.
 *
 * Fastrr dashboard → Settings → Webhooks → add this URL with the event
 * "Abandoned Cart" and FASTRR_WEBHOOK_KEY as the key header. Step 1:
 * every cart is stored (raw + best-effort fields); no message is sent
 * yet. SHOPIFY_ACCOUNT_ID is the CRM account the store belongs to.
 */
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
  const { error } = await supabaseAdmin()
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
  if (error) {
    console.error('[fastrr-cart] could not store cart', error.message)
    return NextResponse.json({ error: 'Could not store cart' }, { status: 500 })
  }
  return NextResponse.json({ status: 'received' }, { status: 200 })
}
