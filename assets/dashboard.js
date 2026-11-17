'use strict';

(function () {
  const list = document.getElementById('license-list');
  const pendingPanel = document.getElementById('pending-panel');
  const pendingList = document.getElementById('pending-list');
  let licenses = [];

  const methodLabels = { cashapp: 'Cash App', paypal: 'PayPal', crypto: 'Crypto' };

  function renderPending(orders) {
    const waiting = orders.filter((order) => order.status === 'awaiting_payment');
    pendingPanel.hidden = !waiting.length;
    if (!waiting.length) return;
    pendingList.innerHTML = waiting
      .map(
        (order) => `
        <article class="license-item pending-item">
          <div class="license-top">
            <h4>${window.KET.escape(order.productName || 'License')}</h4>
            <span class="pill warn">${order.paymentClaimedAt ? 'Claim submitted' : 'Awaiting payment'}</span>
          </div>
          <div class="license-meta">
            <span>Order <b>${window.KET.escape(order.number)}</b></span>
            <span>Amount <b>${window.KET.money(order.amountCents, order.currency)}</b></span>
            <span>Method <b>${window.KET.escape(methodLabels[order.paymentMethod] || 'Manual')}</b></span>
          </div>
          <div class="pending-actions">
            <a class="btn btn-primary btn-small" href="/checkout-success.html?order=${encodeURIComponent(order.number)}">Complete payment</a>
            <span class="form-note">${order.paymentClaimedAt ? 'The owner is verifying your payment.' : 'Your key is issued after confirmation.'}</span>
          </div>
        </article>`
      )
      .join('');
  }

  const statusClass = {
    active: 'ok',
    expired: 'neutral',
    revoked: 'bad',
    blacklisted: 'bad',
  };

  function pill(status) {
    return `<span class="pill ${statusClass[status] || 'neutral'}">${window.KET.escape(status)}</span>`;
  }

  function render() {
    const active = licenses.filter((license) => license.status === 'active').length;
    const expiring = licenses.filter((license) => {
      if (license.status !== 'active' || !license.expiresAt) return false;
      const days = (license.expiresAt - Date.now()) / 86_400_000;
      return days > 0 && days <= 7;
    }).length;
    document.getElementById('stat-active').textContent = String(active);
    document.getElementById('stat-total').textContent = String(licenses.length);
    document.getElementById('stat-expiring').textContent = String(expiring);

    if (!licenses.length) {
      list.innerHTML =
        '<div class="empty-state"><b>No keys yet.</b>Buy a plan and your key appears here instantly.<br><a class="link" href="/#products" style="display:inline-block;margin-top:.7rem">View products</a></div>';
      return;
    }

    list.innerHTML = licenses
      .map((license, index) => {
        const daysLeft = window.KET.daysLeft(license.expiresAt);
        const expiry = license.expiresAt
          ? `${window.KET.date(license.expiresAt)}${daysLeft !== null ? ` · ${daysLeft > 0 ? `${daysLeft}d left` : 'expired'}` : ''}`
          : 'Never';
        return `
          <article class="license-item">
            <div class="license-top">
              <h4>${window.KET.escape(license.productName || 'License')}</h4>
              ${pill(license.status)}
            </div>
            <div class="license-key">
              <code class="masked" id="key-${index}">${window.KET.escape(license.preview || '')}</code>
              <button class="icon-btn" type="button" data-toggle="${index}" title="Reveal key" aria-label="Reveal key">◉</button>
              <button class="icon-btn" type="button" data-copy-key="${index}" title="Copy key" aria-label="Copy key">⧉</button>
            </div>
            <div class="license-meta">
              <span>Account <b>${window.KET.escape(license.email || '—')}</b></span>
              <span>Issued <b>${window.KET.date(license.issuedAt)}</b></span>
              <span>Expires <b>${expiry}</b></span>
            </div>
          </article>`;
      })
      .join('');

    list.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.toggle);
        const code = document.getElementById(`key-${index}`);
        const hidden = code.classList.toggle('masked');
        code.textContent = hidden ? licenses[index].preview : licenses[index].key || licenses[index].preview;
        btn.textContent = hidden ? '◉' : '◌';
      });
    });

    list.querySelectorAll('[data-copy-key]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const license = licenses[Number(btn.dataset.copyKey)];
        if (!license?.key) return window.KET.toast('Key unavailable.', 'error');
        const ok = await window.KET.copy(license.key);
        window.KET.toast(ok ? 'Key copied.' : 'Copy failed.', ok ? 'ok' : 'error');
      });
    });
  }

  async function boot() {
    const data = await window.KET.guard();
    if (!data) return;
    const user = data.user;
    document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = user.email));
    document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = user.displayName || user.email));

    try {
      const [result, ordersResult] = await Promise.all([
        window.KET.api('/api/licenses'),
        window.KET.api('/api/orders').catch(() => ({ orders: [] })),
      ]);
      licenses = result.licenses;
      render();
      renderPending(ordersResult.orders || []);
    } catch (err) {
      list.innerHTML = '<div class="empty-state"><b>Could not load keys.</b>Refresh the page.</div>';
      window.KET.toast(err.message || 'Failed to load keys.', 'error');
    }
  }

  document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', () => window.KET.logout()));
  boot();
})();
