'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind an SSH tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever localhost.run rotates it. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://0c37c736335e48.app.lhr.life';

  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
  if (local) {
    window.KET_API_BASE = '';
    return;
  }

  window.KET_API_BASE = TUNNEL_API;

  /* The CDN caches this file, so revalidate the tunnel from a JSON file with
     no-store. This keeps a rotated hostname from being masked by a stale
     cached config.js. */
  window.KET_API_READY = fetch(`/assets/api-base.json?t=${Date.now()}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const api = data && typeof data.api === 'string' ? data.api.replace(/\/+$/, '') : '';
      if (/^https?:\/\//i.test(api)) window.KET_API_BASE = api;
    })
    .catch(() => null);
})();
