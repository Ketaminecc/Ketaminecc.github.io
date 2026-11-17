'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  const orderNumber = params.get('order');
  const title = document.getElementById('success-title');
  const sub = document.getElementById('success-sub');
  const pending = document.getElementById('pending-box');
  const delivery = document.getElementById('delivery');
  const problem = document.getElementById('problem');
  const problemText = document.getElementById('problem-text');
  let attempts = 0;
  let currentOrder = null;
  let timer = null;

  function showProblem(message) {
    pending.hidden = true;
    delivery.hidden = true;
    problem.hidden = false;
    problemText.textContent = message;
    title.textContent = 'Order needs attention';
    sub.textContent = 'Nothing is lost — the order is in your dashboard.';
  }

  function deliver(order) {
    currentOrder = order;
    pending.hidden = true;
    problem.hidden = true;
    delivery.hidden = false;
    title.textContent = 'License delivered.';
    sub.textContent = 'Payment confirmed. Your key is ready below and saved to your dashboard.';
    document.getElementById('success-icon').textContent = '✓';
    document.getElementById('license-key').textContent = order.license.key;
    document.getElementById('meta-product').textContent = order.productName;
    document.getElementById('meta-order').textContent = order.number;
    document.getElementById('meta-issued').textContent = window.KET.date(order.license.issuedAt);
    document.getElementById('meta-expires').textContent = order.license.expiresAt
      ? window.KET.date(order.license.expiresAt)
      : 'Never (lifetime)';
  }

  async function poll() {
    attempts += 1;
    try {
      const data = await window.KET.api(`/api/orders/${encodeURIComponent(orderNumber)}`);
      const order = data.order;
      if (order.status === 'paid' && order.license && order.license.key) {
        deliver(order);
        return;
      }
      if (['failed', 'expired', 'refunded'].includes(order.status)) {
        showProblem(
          order.status === 'refunded'
            ? 'This order has been refunded and its license revoked.'
            : 'Checkout did not complete. Start a new checkout or contact support with your order number.'
        );
        return;
      }
      if (attempts >= 36) {
        pending.hidden = true;
        problem.hidden = false;
        problemText.textContent = `Still waiting on confirmation for ${order.number}. It will appear in your dashboard as soon as Stripe confirms.`;
        title.textContent = 'Payment still processing';
        sub.textContent = 'Some banks take a few minutes. You can safely close this page.';
        return;
      }
      timer = setTimeout(poll, 2500);
    } catch (err) {
      if (err.status === 404) {
        showProblem('We could not find that order on this account.');
      } else if (attempts >= 36) {
        showProblem(err.message || 'Could not confirm the order.');
      } else {
        timer = setTimeout(poll, 3000);
      }
    }
  }

  async function boot() {
    const me = await window.KET.guard();
    if (!me) return;
    const site = await window.KET.api('/api/site').catch(() => ({}));
    if (site.supportEmail) {
      document.querySelectorAll('[data-support-email]').forEach((el) => {
        el.textContent = site.supportEmail;
        el.href = `mailto:${site.supportEmail}`;
      });
    }
    if (!orderNumber) return showProblem('No order ID was provided in the link.');
    poll();
  }

  document.getElementById('copy-key').addEventListener('click', async () => {
    if (!currentOrder || !currentOrder.license?.key) return;
    const ok = await window.KET.copy(currentOrder.license.key);
    window.KET.toast(ok ? 'License key copied.' : 'Could not copy the key.', ok ? 'ok' : 'error');
  });

  window.addEventListener('beforeunload', () => clearTimeout(timer));
  boot();
})();
