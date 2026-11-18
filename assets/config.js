'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind a tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever the provider rotates it.

   Four sources can name the API and any of them can be one rotation stale, so
   none of them is trusted on sight: every candidate is probed against
   /api/health and the first one that answers wins. A stale Pages document then
   costs one failed request instead of a dead site. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://237f5175d01eb9.app.lhr.life';
  const CACHE_KEY = 'ket.api-base';
  const PROBE_TIMEOUT = 4000;
  const DISCOVER_TIMEOUT = 4000;

  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');

  const trim = (value) => String(value || '').replace(/\/+$/, '');
  const valid = (value) => /^https?:\/\//i.test(value);

  function remember(base) {
    window.KET_API_BASE = base;
    try {
      localStorage.setItem(CACHE_KEY, base);
    } catch {
      /* private mode */
    }
  }

  function recall() {
    try {
      return trim(localStorage.getItem(CACHE_KEY));
    } catch {
      return '';
    }
  }

  async function probe(base) {
    if (!valid(base)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    try {
      const res = await fetch(`${base}/api/health?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
        credentials: 'omit',
      });
      if (!res.ok) return false;
      if (!/application\/json/i.test(res.headers.get('content-type') || '')) return false;
      const data = await res.json().catch(() => null);
      return Boolean(data && data.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Ask Pages for the current tunnel list. Unique query and no-store so a
     rotated hostname is never hidden by a cached document. The watchdog
     publishes a healthy standby alongside the primary when one is running. */
  async function discover() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT);
    try {
      const res = await fetch(`/assets/api-base.json?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
        credentials: 'omit',
      });
      if (!res.ok) return [];
      const data = await res.json();
      const list = [];
      if (data && typeof data.api === 'string') list.push(trim(data.api));
      if (data && Array.isArray(data.fallbacks)) {
        for (const item of data.fallbacks) list.push(trim(item));
      }
      return list.filter(valid);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  function candidates(discovered) {
    /* The static site's own origin is only an API origin during local
       development. Probing it on Pages produces a pointless 404 and a console
       error on every page load. */
    const list = local ? [trim(window.location.origin)] : [];
    list.push(recall(), ...discovered, TUNNEL_API);
    const seen = new Set();
    return list.filter((base) => {
      const key = trim(base).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  let resolving = null;

  function resolveBase() {
    if (resolving) return resolving;
    resolving = (async () => {
      const discovered = await discover();
      const pool = candidates(discovered);
      const verdicts = await Promise.all(pool.map((base) => probe(base)));
      const index = verdicts.indexOf(true);
      if (index !== -1) {
        remember(pool[index]);
        return true;
      }
      window.KET_API_BASE = discovered[0] || TUNNEL_API;
      return false;
    })().finally(() => {
      resolving = null;
    });
    return resolving;
  }

  window.KET_REFRESH_BASE = async function refreshBase() {
    return resolveBase();
  };

  if (local) {
    window.KET_API_BASE = '';
    return;
  }

  window.KET_API_BASE = recall() || TUNNEL_API;
  window.KET_API_READY = resolveBase();
})();
