'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind an SSH tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever localhost.run rotates it.

   Four sources can name the API and any of them can be one rotation stale, so
   none of them is trusted on sight: every candidate is probed against
   /api/health and the first one that answers wins. A stale Pages document then
   costs one failed request instead of a dead site. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://beb5626110bb98.app.lhr.life';
  const CACHE_KEY = 'ket.api-base';
  const PROBE_TIMEOUT = 4500;

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
      const res = await fetch(`${base}/api/health`, {
        cache: 'no-store',
        signal: controller.signal,
        credentials: 'omit',
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return Boolean(data && data.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Ask Pages for the current tunnel. Unique query and no-store so a rotated
     hostname is never hidden by a cached document. */
  async function discover() {
    try {
      const res = await fetch(`/assets/api-base.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return '';
      const data = await res.json();
      const api = trim(data && data.api);
      return valid(api) ? api : '';
    } catch {
      return '';
    }
  }

  function candidates(discovered) {
    const list = [trim(window.location.origin), recall(), discovered, TUNNEL_API];
    const seen = new Set();
    return list.filter((base) => {
      const key = trim(base).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function resolveBase() {
    const discovered = await discover();
    const pool = candidates(discovered);
    const verdicts = await Promise.all(pool.map((base) => probe(base)));
    const index = verdicts.indexOf(true);
    if (index !== -1) {
      remember(pool[index]);
      return true;
    }
    window.KET_API_BASE = discovered || TUNNEL_API;
    return false;
  }

  window.KET_REFRESH_BASE = async function refreshBase() {
    return resolveBase();
  };

  const host = window.location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
  if (local) {
    window.KET_API_BASE = '';
    return;
  }

  window.KET_API_BASE = recall() || TUNNEL_API;
  window.KET_API_READY = resolveBase();
})();
