'use strict';

/* Shared client helpers */
(function () {
  const KET = (window.KET = window.KET || {});
  const apiBase = () => String(window.KET_API_BASE || '').replace(/\/+$/, '');

  /* Split hosting keeps the API on a different origin, where third-party
     cookies are unreliable. Sessions are therefore carried as bearer tokens. */
  const TOKEN_KEYS = { user: 'ket_token', admin: 'ket_admin_token' };
  const tokenKeyFor = (path) => (String(path).startsWith('/api/admin') ? TOKEN_KEYS.admin : TOKEN_KEYS.user);
  const readToken = (key) => {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  };
  const writeToken = (key, value) => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  };

  const apiUrl = (path) => (/^https?:\/\//i.test(path) ? path : `${apiBase()}${path}`);

  KET.api = async function api(path, options = {}) {
    if (window.KET_API_READY) await window.KET_API_READY;
    const tokenKey = tokenKeyFor(path);
    const token = readToken(tokenKey);
    const opts = {
      method: options.method || 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(apiUrl(path), opts);
    } catch (err) {
      /* A tunnel rotation can invalidate the hostname mid-session. Refresh it
         and retry safe reads once; never retry a POST (checkout must not run twice). */
      const method = String(opts.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw err;
      const before = apiBase();
      const refreshed = typeof window.KET_REFRESH_BASE === 'function' ? await window.KET_REFRESH_BASE() : false;
      if (refreshed && apiBase() !== before) {
        res = await fetch(apiUrl(path), opts);
      } else {
        /* Short tunnel hiccup: one delayed retry keeps pages from failing on a
           reconnect that finishes between the first attempt and the refresh. */
        await new Promise((resolve) => setTimeout(resolve, 1500));
        res = await fetch(apiUrl(path), opts);
      }
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && typeof data.token === 'string' && data.token) writeToken(tokenKey, data.token);
    if (/\/(?:auth|admin)\/logout$/.test(String(path))) writeToken(tokenKey, '');
    if (!res.ok) {
      const error = new Error((data && data.error) || `Request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  };

  KET.money = function money(cents, currency = 'usd') {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: String(currency || 'usd').toUpperCase(),
        minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      }).format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  };

  KET.date = function date(ms, withTime = false) {
    if (!ms) return '—';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    });
  };

  KET.relative = function relative(ms) {
    if (!ms) return '—';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const day = 86_400_000;
    if (abs < 60 * 60_000) {
      const mins = Math.max(1, Math.round(abs / 60_000));
      return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
    }
    if (abs < day) {
      const hours = Math.round(abs / 3_600_000);
      return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
    }
    const days = Math.round(abs / day);
    return diff > 0 ? `in ${days}d` : `${days}d ago`;
  };

  KET.daysLeft = function daysLeft(ms) {
    if (!ms) return null;
    return Math.ceil((ms - Date.now()) / 86_400_000);
  };

  KET.escape = function escape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  KET.safeNext = function safeNext(next, fallback = '/dashboard.html') {
    if (typeof next !== 'string') return fallback;
    if (!next.startsWith('/') || next.startsWith('//')) return fallback;
    return next;
  };

  KET.toast = function toast(message, type = 'ok', title = null) {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div>${title ? `<strong>${KET.escape(title)}</strong>` : ''}${KET.escape(message)}</div>`;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 250);
    }, 4200);
  };

  KET.copy = async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  };

  KET.initials = function initials(name) {
    return String(name || '?')
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');
  };

  KET.me = async function me() {
    try {
      return await KET.api('/api/me');
    } catch {
      return { user: null };
    }
  };

  KET.guard = async function guard() {
    const data = await KET.me();
    if (!data.user) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login.html?next=${next}`);
      return null;
    }
    return data;
  };

  KET.refreshAuth = async function refreshAuth() {
    const data = await KET.me();
    const user = data.user;
    document.querySelectorAll('[data-auth="guest"]').forEach((el) => {
      el.hidden = Boolean(user);
    });
    document.querySelectorAll('[data-auth="user"]').forEach((el) => {
      el.hidden = !user;
    });
    document.querySelectorAll('[data-user-name]').forEach((el) => {
      el.textContent = user ? user.displayName || user.email : '';
    });
    document.querySelectorAll('[data-user-email]').forEach((el) => {
      el.textContent = user ? user.email : '';
    });
    return user;
  };

  KET.logout = async function logout() {
    try {
      await KET.api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* ignore */
    }
    window.location.href = '/';
  };

  /* Snowfall — real six-armed flakes drawn on canvas */
  function initSnow() {
    const canvas = document.getElementById('snow');
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let flakes = [];
    let raf = 0;
    let last = performance.now();

    function makeFlake(initial = false) {
      const radius = 1.8 + Math.random() * 4.2;
      return {
        x: Math.random() * width,
        y: initial ? Math.random() * height : -12 - Math.random() * 40,
        r: radius,
        speed: 10 + radius * 8 + Math.random() * 14,
        sway: 8 + Math.random() * 26,
        phase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.6,
        rot: Math.random() * Math.PI,
        alpha: 0.2 + Math.random() * 0.55,
      };
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.min(74, Math.max(22, Math.round((width * height) / 26000)));
      while (flakes.length < target) flakes.push(makeFlake(true));
      flakes = flakes.slice(0, target);
    }

    function drawFlake(flake) {
      const { r } = flake;
      const arm = r;
      ctx.save();
      ctx.translate(flake.x, flake.y);
      ctx.rotate(flake.rot);
      ctx.strokeStyle = `rgba(255,255,255,${flake.alpha})`;
      ctx.lineWidth = Math.max(0.55, r * 0.11);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        ctx.moveTo(0, 0);
        ctx.lineTo(dx * arm, dy * arm);
        if (r > 1.9) {
          for (const [dist, len] of [
            [0.42, 0.32],
            [0.68, 0.24],
          ]) {
            const bx = dx * arm * dist;
            const by = dy * arm * dist;
            const spread = 0.62;
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(angle + spread) * arm * len, by + Math.sin(angle + spread) * arm * len);
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + Math.cos(angle - spread) * arm * len, by + Math.sin(angle - spread) * arm * len);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, width, height);
      for (const flake of flakes) {
        flake.phase += dt * 0.7;
        flake.y += flake.speed * dt;
        flake.x += Math.sin(flake.phase) * flake.sway * dt;
        flake.rot += flake.spin * dt;
        if (flake.y > height + 14 || flake.x < -30 || flake.x > width + 30) {
          Object.assign(flake, makeFlake(false));
        }
        drawFlake(flake);
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    }

    resize();
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    start();
  }

  function initReveal() {
    const nodes = document.querySelectorAll('.reveal');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('in-view'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    nodes.forEach((n) => io.observe(n));
  }

  function initNav() {
    const toggle = document.querySelector('.nav-toggle');
    const header = document.querySelector('.site-header, .app-topbar');
    if (!toggle || !header) return;
    toggle.addEventListener('click', () => {
      const open = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('.main-nav a').forEach((link) =>
      link.addEventListener('click', () => header.classList.remove('nav-open'))
    );
  }

  function initKeyToggle() {
    document.querySelectorAll('[data-reveal-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const box = btn.closest('.console-key');
        if (!box) return;
        const revealed = box.classList.toggle('revealed');
        btn.textContent = revealed ? 'Hide' : 'Reveal';
      });
    });
  }

  function initCopyButtons() {
    document.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-copy]');
      if (!btn) return;
      const value = btn.getAttribute('data-copy');
      const ok = await KET.copy(value);
      KET.toast(ok ? 'Copied to clipboard.' : 'Could not copy — select it manually.', ok ? 'ok' : 'error');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSnow();
    initReveal();
    initNav();
    initKeyToggle();
    initCopyButtons();
    KET.refreshAuth();
    document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', () => KET.logout()));
  });
})();
