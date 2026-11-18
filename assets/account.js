'use strict';

(function () {
  const ordersBody = document.getElementById('orders-body');
  const errorBox = document.getElementById('password-error');
  const setupEntry = document.getElementById('setup-entry');

  const statusClass = {
    paid: 'ok',
    pending: 'warn',
    refunded: 'neutral',
    expired: 'neutral',
    failed: 'bad',
  };

  function pill(status) {
    return `<span class="pill ${statusClass[status] || 'neutral'}">${window.KET.escape(status)}</span>`;
  }

  function renderOrders(orders) {
    if (!orders.length) {
      ordersBody.innerHTML = '<tr><td colspan="6" class="table-empty">No orders yet.</td></tr>';
      return;
    }
    ordersBody.innerHTML = orders
      .map(
        (order) => `
        <tr>
          <td class="num">${window.KET.escape(order.number)}</td>
          <td>${window.KET.escape(order.productName)}</td>
          <td class="num">${window.KET.money(order.amountCents, order.currency)}</td>
          <td>${pill(order.status)}</td>
          <td class="dim">${window.KET.date(order.createdAt)}</td>
          <td><a class="btn btn-subtle btn-small" href="/checkout-success.html?order=${encodeURIComponent(order.number)}">View</a></td>
        </tr>`
      )
      .join('');
  }

  async function boot() {
    const data = await window.KET.guard();
    if (!data) return;
    const user = data.user;

    document.getElementById('profile-avatar').textContent = window.KET.initials(user.displayName || user.email);
    document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = user.displayName || 'Account'));
    document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = user.email));
    document.getElementById('member-since').textContent = window.KET.date(user.createdAt);

    const [ordersResult, licensesResult] = await Promise.allSettled([
      window.KET.api('/api/orders'),
      window.KET.api('/api/licenses'),
    ]);

    if (ordersResult.status === 'fulfilled') {
      renderOrders(ordersResult.value.orders || []);
    } else {
      ordersBody.innerHTML = '<tr><td colspan="6" class="table-empty">Could not load orders.</td></tr>';
      window.KET.toast(ordersResult.reason?.message || 'Failed to load orders.', 'error');
    }

    if (licensesResult.status === 'fulfilled') {
      const licenses = licensesResult.value.licenses || [];
      setupEntry.hidden = !licenses.some((license) => license.status === 'active');
    }
  }

  document.getElementById('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.remove('show');
    const current = document.getElementById('current-password').value;
    const next = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    if (next.length < 8) {
      errorBox.textContent = 'Minimum 8 characters.';
      errorBox.classList.add('show');
      return;
    }
    if (next !== confirm) {
      errorBox.textContent = 'Passwords do not match.';
      errorBox.classList.add('show');
      return;
    }
    const btn = document.getElementById('password-submit');
    btn.disabled = true;
    try {
      await window.KET.api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      document.getElementById('password-form').reset();
      window.KET.toast('Password updated.', 'ok');
    } catch (err) {
      errorBox.textContent = err.message || 'Update failed.';
      errorBox.classList.add('show');
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', () => window.KET.logout()));
  boot();
})();
