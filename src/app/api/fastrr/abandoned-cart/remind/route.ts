import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fastrrRequestAuthorized } from '@/lib/fastrr/abandoned-cart'
import { remindCart, type CartRow } from '@/lib/fastrr/cart-reminder'

/**
 * Re-run reminders for carts still waiting (status `received`), e.g.
 * the carts that arrived before Meta approved the template. Same key
 * header as the Fastrr webhook. Every safety check in `remindCart`
 * (one per cart, one per number a day, already ordered, STOP, 48 h)
 * still applies.
 */
export const maxDuration = 60

export async function POST(request: Request) {
  const secret = process.env.FASTRR_WEBHOOK_KEY
  const accountId = process.env.SHOPIFY_ACCOUNT_ID
  if (!secret || !accountId) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!fastrrRequestAuthorized(request, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('fastrr_abandoned_carts')
    .select('id, account_id, cart_id, phone, checkout_url, status, payload, received_at')
    .eq('account_id', accountId)
    .eq('status', 'received')
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(20)
  if (error) return NextResponse.json({ error: 'Could not read carts' }, { status: 500 })

  const results = []
  for (const row of (data ?? []) as CartRow[]) {
    const outcome = await remindCart(db, row)
    results.push({ id: row.id, status: outcome.status, reason: 'reason' in outcome ? outcome.reason : null })
  }
  return NextResponse.json({ processed: results.length, results })
}
