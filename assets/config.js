'use strict';

/* Split hosting: static pages live on GitHub Pages while the API runs on the
   owner's PC behind a tunnel. The tunnel hostname is rewritten by
   scripts/tunnel-watchdog.ps1 whenever the provider rotates it.

   Four sources can name the API and any of them can be one rotation stale, so
   none of them is trusted on sight: every candidate is probed against
   /api/health and the first one that answers wins. The list published on Pages
   is tried first; the compiled hostname and the last working base are only
   probed when that list is stale or unreachable, so a normal rotation does not
   log a failed request against the old tunnel. */
(function () {
  if (window.KET_API_BASE !== undefined) return;

  const TUNNEL_API = 'https://parish-fixed-fought-forge.trycloudflare.com';
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

  /* Resolve as soon as one candidate answers instead of waiting for every
     stale hostname to time out. */
  function firstHealthy(pool) {
    return new Promise((resolve) => {
      const seen = new Set();
      const bases = pool.filter((base) => {
        const key = trim(base).toLowerCase();
        if (!key || seen.has(key) || !valid(base)) return false;
        seen.add(key);
        return true;
      });
      if (bases.length === 0) {
        resolve('');
        return;
      }
      let pending = bases.length;
      const miss = () => {
        pending -= 1;
        if (pending === 0) resolve('');
      };
      for (const base of bases) {
        probe(base).then((ok) => (ok ? resolve(base) : miss())).catch(miss);
      }
    });
  }

  let resolving = null;

  function resolveBase() {
    if (resolving) return resolving;
    resolving = (async () => {
      const discovered = await discover();
      let winner = await firstHealthy(discovered);
      if (!winner) {
        winner = await firstHealthy([TUNNEL_API, recall()]);
      }
      if (winner) {
        remember(winner);
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
