'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind an SSH tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever localhost.run rotates it. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://cff18db8b13ed0.app.lhr.life';

  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
  if (local) {
    window.KET_API_BASE = '';
    return;
  }

  window.KET_API_BASE = TUNNEL_API;
})();
