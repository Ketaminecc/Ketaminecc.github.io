'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind an SSH tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever localhost.run rotates it. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://1767271d49ead4.app.lhr.life';

  /* Ask Pages for the current tunnel. The JSON is fetched with a unique query
     and no-store so a rotated hostname is not hidden by a cached config.js. */
  window.KET_REFRESH_BASE = async function refreshBase() {
    try {
      const res = await fetch(`/assets/api-base.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      const api = data && typeof data.api === 'string' ? data.api.replace(/\/+$/, '') : '';
      if (!/^https?:\/\//i.test(api)) return false;
      window.KET_API_BASE = api;
      return true;
    } catch {
      return false;
    }
  };

  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
  if (local) {
    window.KET_API_BASE = '';
    return;
  }

  window.KET_API_BASE = TUNNEL_API;
  window.KET_API_READY = window.KET_REFRESH_BASE();
})();
