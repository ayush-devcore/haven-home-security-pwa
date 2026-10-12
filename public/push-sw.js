/* Imported by the generated Workbox service worker. Keep this file as classic JS. */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "A new security event was received." };
  }

  const title = typeof payload.title === "string" ? payload.title : "Haven security alert";
  const body = typeof payload.body === "string" ? payload.body : "A new security event was received.";
  const tag = typeof payload.tag === "string" ? payload.tag : "haven-security-alert";
  const url = typeof payload.url === "string" ? payload.url : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/haven-icon-192.png",
      badge: "/haven-icon-192.png",
      data: { url },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : "/",
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          if ("navigate" in client) void client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
