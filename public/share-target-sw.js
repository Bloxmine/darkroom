/*
 * Darkroom — Web Share Target handler. Loaded into the generated Workbox
 * service worker via `workbox.importScripts` (vite.config.ts), so this fetch
 * listener is registered before Workbox's own routes.
 *
 * The OS share sheet POSTs multipart/form-data to /share-target. We stash the
 * files in Cache Storage and redirect to /?share-target=<n>; the app
 * (src/store/launch.ts → takeSharedFiles) reads and deletes them on load.
 */
const DARKROOM_SHARE_CACHE = 'darkroom-share-target';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== '/share-target') return;
  event.respondWith(
    (async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('files').filter((f) => typeof f !== 'string');
        const cache = await caches.open(DARKROOM_SHARE_CACHE);
        for (const k of await cache.keys()) await cache.delete(k); // drop leftovers of an earlier share
        const stamp = Date.now();
        await Promise.all(
          files.map((f, i) =>
            cache.put(
              new Request(`/__share-target/${stamp}-${String(i).padStart(4, '0')}`),
              new Response(f, {
                headers: {
                  'content-type': f.type || 'application/octet-stream',
                  'x-file-name': encodeURIComponent(f.name || `shared-${i + 1}`),
                  'x-last-modified': String(f.lastModified || stamp),
                },
              }),
            ),
          ),
        );
        return Response.redirect(`/?share-target=${files.length}`, 303);
      } catch (e) {
        console.error('[darkroom] share target failed', e);
        return Response.redirect('/?share-target=error', 303);
      }
    })(),
  );
});
