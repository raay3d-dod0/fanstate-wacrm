/* Fanstate CRM service worker.
 *
 * Only job: receive Web Push events and show a system notification, then
 * focus or open the right conversation when it is tapped. No caching, no
 * offline mode — the app stays online-only so nothing stale is ever shown.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Fanstate CRM", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Fanstate CRM";
  const options = {
    body: data.body || "",
    icon: "/favicon-192.png",
    badge: "/favicon-192.png",
    // Same conversation collapses into one notification instead of stacking.
    tag: data.tag || "fanstate-crm",
    renotify: true,
    data: { url: data.url || "/inbox" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/inbox", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
