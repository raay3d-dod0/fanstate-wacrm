import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { fastrrRequestAuthorized } from '@/lib/fastrr/abandoned-cart'
import { remindCart, type CartRow } from '@/lib/fastrr/cart-reminder'

/**
 * Re-run reminders for carts still waiting (status `received`), e.g.
 * the carts that arrived before Meta approved the template, and make
 * the one next-day retry for carts whose first reminder Meta dropped
 * (131049). Every safety check in `remindCart` (one per cart, one per
 * number a day, already ordered, STOP, cart age) still applies.
 *
 * Auth: the Fastrr key header, or Vercel Cron's `Authorization: Bearer
 * $CRON_SECRET` (daily run in vercel.json, GET).
 */
export const maxDuration = 60

const COLUMNS = 'id, account_id, cart_id, phone, checkout_url, status, payload, received_at, reminded_at'

export async function GET(request: Request) {
  return run(request)
}

export async function POST(request: Request) {
  return run(request)
}

async function run(request: Request) {
  const secret = process.env.FASTRR_WEBHOOK_KEY
  const accountId = process.env.SHOPIFY_ACCOUNT_ID
  if (!secret || !accountId) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  const cronSecret = process.env.CRON_SECRET
  const authorized =
    fastrrRequestAuthorized(request, secret) || (cronSecret ? fastrrRequestAuthorized(request, cronSecret) : false)
  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('fastrr_abandoned_carts')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('status', 'received')
    .gte('received_at', since)
    .order('received_at', { ascending: true })
    .limit(20)
  if (error) return NextResponse.json({ error: 'Could not read carts' }, { status: 500 })

  const now = Date.now()
  const { data: retryRows, error: retryError } = await db
    .from('fastrr_abandoned_carts')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('status', 'reminded')
    .lte('reminded_at', new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .gte('received_at', new Date(now - 72 * 60 * 60 * 1000).toISOString())
    .order('received_at', { ascending: true })
    .limit(20)
  if (retryError) return NextResponse.json({ error: 'Could not read carts' }, { status: 500 })

  const results = []
  for (const row of (data ?? []) as CartRow[]) {
    const outcome = await remindCart(db, row)
    results.push({ id: row.id, mode: 'first', status: outcome.status, reason: 'reason' in outcome ? outcome.reason : null })
  }
  for (const row of (retryRows ?? []) as CartRow[]) {
    const outcome = await remindCart(db, row, new Date(), 'retry')
    results.push({ id: row.id, mode: 'retry', status: outcome.status, reason: 'reason' in outcome ? outcome.reason : null })
  }
  return NextResponse.json({ processed: results.length, results })
}
