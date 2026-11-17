'use strict';

/* Split hosting: static pages may live on GitHub Pages while the API stays on Render.
   Local development keeps same-origin requests. */
(function () {
  if (window.KET_API_BASE !== undefined) return;
  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '';
  window.KET_API_BASE = local ? '' : 'https://api.ketaminecc.site';
})();
