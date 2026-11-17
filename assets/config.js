'use strict';

/* Split hosting: static pages may live on GitHub Pages while the API stays on Render.
   Local development keeps same-origin requests. */
(function () {
  if (window.KET_API_BASE !== undefined) return;
  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
  if (local) {
    window.KET_API_BASE = '';
    return;
  }
  const root = host.replace(/^www\./, '');
  const match = root.match(/ketaminecc\.(site|website)$/);
  window.KET_API_BASE = `https://api.ketaminecc.${match ? match[1] : 'website'}`;
})();
