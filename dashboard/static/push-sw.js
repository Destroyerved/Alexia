/* Alexia DevSecOps Guardian — Web Push Service Worker Extension (FR-M2, FR-M3, FR-M4) */
self.addEventListener('push', (event) => {
  let payload = {
    title: 'Alexia Guardian Alert',
    body: 'DevSecOps event requires your attention.',
    deep_link: '/',
    severity: 'high',
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    }
  } catch {
    if (event.data) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: payload.incident_id || payload.id || 'alexia-alert',
    renotify: true,
    data: {
      url: payload.deep_link || '/',
      incident_id: payload.incident_id,
    },
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
