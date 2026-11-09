/**
 * Read-only Shopify Admin access for the CRM (order lookups).
 *
 * Uses the store's own custom app (Fanstate Studio) with Shopify's
 * client-credentials grant: client id + secret → an access token that
 * lasts ~24 h. The token is cached in memory and refreshed a few
 * minutes before it expires.
 *
 * Env: SHOPIFY_STORE (e.g. 5h9tvt-qw.myshopify.com), SHOPIFY_CLIENT_ID,
 * SHOPIFY_CLIENT_SECRET. If the app's secret is rotated in Shopify,
 * update it here AND in the Studio app.
 */

const API_VERSION = '2026-10'

let cached: { token: string; expiresAt: number } | null = null

export function shopifyAdminConfigured(): boolean {
  return Boolean(
    process.env.SHOPIFY_STORE && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET,
  )
}

function storeDomain(): string {
  return (process.env.SHOPIFY_STORE ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token
  const res = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) throw new Error(`Shopify token request failed (${res.status})`)
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Shopify token response had no access_token')
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
  }
  return cached.token
}

export async function shopifyGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken()
  const res = await fetch(`https://${storeDomain()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 401) cached = null
  if (!res.ok) throw new Error(`Shopify GraphQL failed (${res.status})`)
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join('; ')}`)
  return json.data as T
}
