// ============================================================
// /api/push/subscriptions
//
//   POST   — register this browser's Web Push subscription.  Any member.
//   DELETE — remove it (body: { endpoint }).                  Any member.
//
// Rows are scoped to the caller (RLS) and pinned to the account they are
// in now, so the webhook can fan out by account_id alone.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

/**
 * Push endpoints must point at a known browser push service. Web Push
 * is a server-to-server POST to whatever URL the client hands us, so an
 * unvetted endpoint would turn the webhook into an SSRF primitive.
 */
const ALLOWED_PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^fcm\.googleapis\.com$/,                 // Chrome / Chromium / Android
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.apple\.com$/,          // Safari / iOS
  /^[a-z0-9-]+\.notify\.windows\.com$/,      // Edge legacy (WNS)
  /^[a-z0-9.-]*\.push\.services\.mozilla\.com$/,
];

function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.some((re) => re.test(host));
}

interface SubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as SubscriptionBody | null;
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (
      typeof endpoint !== "string" ||
      endpoint.length > 2048 ||
      !isAllowedPushEndpoint(endpoint) ||
      typeof p256dh !== "string" ||
      typeof auth !== "string"
    ) {
      return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
    }

    const userAgent = request.headers.get("user-agent")?.slice(0, 255) ?? null;

    // Endpoint is globally unique; if this browser re-subscribes, replace.
    await ctx.supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    const { error } = await ctx.supabase.from("push_subscriptions").insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      endpoint,
      p256dh,
      auth,
      user_agent: userAgent,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as SubscriptionBody | null;
    const endpoint = body?.endpoint;
    if (typeof endpoint !== "string") {
      return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
    }
    const { error } = await ctx.supabase
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", endpoint);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
