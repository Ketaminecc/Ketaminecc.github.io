'use strict';

(function () {
  const loading = document.getElementById('setup-loading');
  const locked = document.getElementById('setup-locked');
  const lockedCopy = document.getElementById('setup-locked-copy');
  const content = document.getElementById('setup-content');
  const activePill = document.getElementById('setup-active-pill');
  const licenseMeta = document.getElementById('setup-license-meta');
  const licenseGames = document.getElementById('setup-license-games');

  const GAME_LABEL = { cs2: 'Counter-Strike 2' };
  const panels = Array.from(document.querySelectorAll('[data-doc-panel]'));
  const links = Array.from(document.querySelectorAll('[data-doc]'));

  // Which games this account may download. Filled during boot; a build button
  // for a game the account has no key for stays disabled with the reason.
  const owned = new Set();

  function showLocked(message) {
    loading.hidden = true;
    content.hidden = true;
    activePill.hidden = true;
    locked.hidden = false;
    if (message) lockedCopy.textContent = message;
  }

  // One doc at a time, addressed by the hash so /setup#cs2 can be linked.
  function showDoc(game) {
    const wanted = GAME_LABEL[game] ? game : 'cs2';

    panels.forEach((panel) => {
      panel.hidden = panel.dataset.docPanel !== wanted;
    });
    links.forEach((link) => {
      const active = link.dataset.doc === wanted;
      link.classList.toggle('is-active', active);
      link.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', `${window.location.pathname}#${wanted}`);
    }
  }

  function markOwnership() {
    document.querySelectorAll('[data-download]').forEach((button) => {
      const game = button.dataset.download;
      const panel = button.closest('[data-doc-panel]');
      const status = panel ? panel.querySelector('[data-download-status]') : null;

      if (owned.size && !owned.has(game)) {
        button.disabled = true;
        if (status) {
          status.textContent = `Your active license is for ${Array.from(owned)
            .map((g) => GAME_LABEL[g] || g)
            .join(' and ')}. Buy a ${GAME_LABEL[game] || game} key to unlock this build.`;
        }
      }
    });
  }

  async function boot() {
    const data = await window.KET.guard();
    if (!data) return;
    document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = data.user.email));

    let result;
    try {
      result = await window.KET.api('/api/licenses');
    } catch {
      showLocked('We could not verify your license right now. Refresh the page or check your Keys page.');
      return;
    }

    const active = (result.licenses || []).filter((license) => license.status === 'active');
    if (!active.length) {
      showLocked();
      return;
    }

    active.forEach((license) => owned.add(String(license.game || 'cs2').toLowerCase()));

    const license = active[0];
    const expiry = license.expiresAt ? `Expires ${window.KET.date(license.expiresAt)}` : 'Lifetime license';
    licenseMeta.textContent = `${license.productName || 'License'} · ${expiry}`;
    licenseGames.textContent = Array.from(owned)
      .map((game) => GAME_LABEL[game] || game)
      .join(' · ');

    loading.hidden = true;
    locked.hidden = true;
    content.hidden = false;
    activePill.hidden = false;

    // Open the doc for the first license the account owns, unless a hash names
    // a game on purpose.
    const hash = String(window.location.hash || '').replace('#', '').toLowerCase();
    showDoc(GAME_LABEL[hash] ? hash : Array.from(owned)[0] || 'cs2');
    markOwnership();
  }

  links.forEach((link) => {
    link.addEventListener('click', () => showDoc(link.dataset.doc));
  });

  // Build downloads are ticket based: fetch a fresh single-use link on click,
  // then navigate to it. Nothing in the markup holds a usable URL, and the
  // server only issues a ticket for a game on the signed-in account.
  let downloading = false;

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-download]');
    if (!button || downloading || button.disabled) return;
    event.preventDefault();

    const product = button.dataset.download;
    const panel = button.closest('[data-doc-panel]');
    const status = panel ? panel.querySelector('[data-download-status]') : null;
    const label = button.textContent;

    downloading = true;
    button.disabled = true;
    if (status) status.textContent = 'Issuing a download link…';

    try {
      const result = await window.KET.api(`/api/downloads/${encodeURIComponent(product)}`);
      if (!result || !result.url) throw new Error('no link');
      const base = String(window.KET_API_BASE || '').replace(/\/+$/, '');
      window.location.href = `${base}${result.url}`;
      if (status) status.textContent = 'Download started. The link is now used up.';
    } catch (err) {
      if (status) {
        status.textContent =
          (err && err.message) || 'Could not issue a link. Refresh the page and try again.';
      }
    } finally {
      downloading = false;
      // markOwnership disabled this one for a reason: leave it disabled.
      button.disabled = owned.size > 0 && !owned.has(product);
      button.textContent = label;
    }
  });

  document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', () => window.KET.logout()));
  boot();
})();
