'use strict';

(function () {
  const loading = document.getElementById('setup-loading');
  const locked = document.getElementById('setup-locked');
  const lockedCopy = document.getElementById('setup-locked-copy');
  const content = document.getElementById('setup-content');
  const activePill = document.getElementById('setup-active-pill');
  const licenseMeta = document.getElementById('setup-license-meta');

  function showLocked(message) {
    loading.hidden = true;
    content.hidden = true;
    activePill.hidden = true;
    locked.hidden = false;
    if (message) lockedCopy.textContent = message;
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

    const license = active[0];
    const expiry = license.expiresAt ? `Expires ${window.KET.date(license.expiresAt)}` : 'Lifetime license';
    licenseMeta.textContent = `${license.productName || 'License'} · ${expiry}`;

    loading.hidden = true;
    locked.hidden = true;
    content.hidden = false;
    activePill.hidden = false;
  }

  document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', () => window.KET.logout()));
  boot();
})();
