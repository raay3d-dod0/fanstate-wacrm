import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Web Push fan-out for one account.
 *
 * Called from the WhatsApp webhook (service-role client) after an inbound
 * message is stored. Sends to every device subscription in the account,
 * and prunes subscriptions the push service reports as gone (404/410).
 *
 * Never throws: a push failure must not affect the webhook's 200 to Meta.
 * Silently no-ops when VAPID keys are not configured.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Path to open on tap, e.g. `/inbox?c=<id>`. */
  url: string;
  /** Collapse key; same tag replaces the previous notification. */
  tag?: string;
}

let configured = false;

function ensureConfigured(): boolean {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

export async function sendPushToAccount(
  db: SupabaseClient,
  accountId: string,
  payload: PushPayload
): Promise<void> {
  try {
    if (!ensureConfigured()) return;

    // Membership is checked at send time, not trusted from the row: a
    // user removed from the account (or who moved accounts) keeps their
    // old subscription rows until pruned, and must not receive messages.
    const { data: members, error: memberErr } = await db
      .from("profiles")
      .select("user_id")
      .eq("account_id", accountId);
    if (memberErr || !members || members.length === 0) return;
    const memberIds = members.map((m) => m.user_id as string);

    const { data: subs, error } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth, user_id")
      .eq("account_id", accountId)
      .in("user_id", memberIds);
    if (error || !subs || subs.length === 0) return;

    const body = JSON.stringify(payload);
    const gone: string[] = [];
    const used: string[] = [];

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 60 * 60, urgency: "high" }
          );
          used.push(s.id);
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            gone.push(s.id);
          } else {
            console.error("[push] send failed:", status, (err as Error)?.message);
          }
        }
      })
    );

    if (gone.length) {
      await db.from("push_subscriptions").delete().in("id", gone);
    }
    if (used.length) {
      await db
        .from("push_subscriptions")
        .update({ last_used_at: new Date().toISOString() })
        .in("id", used);
    }
  } catch (err) {
    console.error("[push] fan-out failed:", err);
  }
}
