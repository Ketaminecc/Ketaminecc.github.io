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
  const manualBox = document.getElementById('manual-box');
  const manualOrder = document.getElementById('manual-order');
  const manualAmount = document.getElementById('manual-amount');
  const manualInstructions = document.getElementById('manual-instructions');
  const manualLinks = document.getElementById('manual-links');
  const manualCrypto = document.getElementById('manual-crypto');
  const ticketLink = document.getElementById('ticket-link');
  const claimForm = document.getElementById('claim-form');
  const claimReference = document.getElementById('claim-reference');
  const claimSubmit = document.getElementById('claim-submit');
  const claimError = document.getElementById('claim-error');
  const claimStatus = document.getElementById('claim-status');
  let attempts = 0;
  let currentOrder = null;
  let manualSite = null;
  let manualMode = false;
  let timer = null;

  function showProblem(message) {
    pending.hidden = true;
    delivery.hidden = true;
    manualBox.hidden = true;
    problem.hidden = false;
    problemText.textContent = message;
    title.textContent = 'Order needs attention';
    sub.textContent = 'Nothing is lost — the order is in your dashboard.';
  }

  function deliver(order) {
    currentOrder = order;
    pending.hidden = true;
    problem.hidden = true;
    manualBox.hidden = true;
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

  function addManualLink(href, label, primary = true) {
    const link = document.createElement('a');
    link.className = `btn ${primary ? 'btn-primary' : 'btn-subtle'} btn-block`;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    manualLinks.appendChild(link);
  }

  function renderManual(order, site) {
    currentOrder = order;
    manualMode = true;
    pending.hidden = true;
    delivery.hidden = true;
    problem.hidden = true;
    manualBox.hidden = false;

    const manual = (site && site.manual) || {};
    const method = order.paymentMethod || '';
    const amount = window.KET.money(order.amountCents, order.currency);
    const dollars = (order.amountCents / 100).toFixed(2);
    const methodLabel = method === 'cashapp' ? 'Cash App' : method === 'paypal' ? 'PayPal' : method === 'crypto' ? 'crypto' : 'the payment method';

    title.textContent = 'Complete payment.';
    sub.textContent = `Send ${amount} with ${methodLabel}, include your order number, then confirm below.`;
    document.getElementById('success-icon').textContent = '$';
    manualOrder.textContent = order.number;
    manualAmount.textContent = amount;
    manualInstructions.textContent =
      manual.instructions ||
      'Pay the exact amount, include your order number in the note, then submit the transaction ID or open a Discord ticket.';

    manualLinks.innerHTML = '';
    manualCrypto.hidden = true;
    manualCrypto.textContent = '';

    if (method === 'cashapp' && manual.cashapp) {
      addManualLink(`https://cash.app/${manual.cashapp}/${dollars}`, `Pay ${amount} with Cash App`);
    } else if (method === 'paypal' && manual.paypal) {
      addManualLink(`${String(manual.paypal).replace(/\/+$/, '')}/${dollars}`, `Pay ${amount} with PayPal`);
    } else if (method === 'crypto' && manual.crypto) {
      manualCrypto.hidden = false;
      manualCrypto.textContent = manual.crypto;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-subtle btn-block';
      copy.textContent = 'Copy crypto details';
      copy.addEventListener('click', async () => {
        const ok = await window.KET.copy(manual.crypto);
        window.KET.toast(ok ? 'Crypto details copied.' : 'Copy failed.', ok ? 'ok' : 'error');
      });
      manualLinks.appendChild(copy);
    }

    const ticketUrl = manual.ticketUrl || (site && site.discordInvite) || '';
    ticketLink.hidden = !ticketUrl;
    if (ticketUrl) ticketLink.href = ticketUrl;

    if (order.paymentClaimedAt) {
      claimForm.hidden = true;
      claimStatus.hidden = false;
      claimStatus.textContent =
        `Payment claim submitted ${window.KET.date(order.paymentClaimedAt, true)}` +
        `${order.paymentRef ? ` · ${order.paymentRef}` : ''}. Waiting for the owner to confirm.`;
    } else {
      claimForm.hidden = false;
      claimStatus.hidden = true;
    }
  }

  async function poll() {
    attempts += 1;
    try {
      const base = `/api/orders/${encodeURIComponent(orderNumber)}`;
      const manual = manualMode || (manualSite && manualSite.payments === 'manual');
      const sync = !manual && attempts % 2 === 1;
      const data = await window.KET.api(sync ? `${base}/sync` : base, sync ? { method: 'POST', body: {} } : {});
      const order = data.order;

      if (order.status === 'paid' && order.license && order.license.key) {
        deliver(order);
        return;
      }

      if (order.status === 'awaiting_payment') {
        renderManual(order, manualSite);
        if (attempts >= 180) {
          sub.textContent =
            'Still awaiting confirmation. It will appear in your dashboard as soon as the owner approves it.';
          return;
        }
        timer = setTimeout(poll, 10000);
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
        problemText.textContent = `Still waiting on confirmation for ${order.number}. It will appear in your dashboard as soon as it is approved.`;
        title.textContent = 'Payment still processing';
        sub.textContent = 'You can safely close this page.';
        return;
      }
      timer = setTimeout(poll, manual ? 10000 : 2500);
    } catch (err) {
      if (err.status === 404) {
        showProblem('We could not find that order on this account.');
      } else if (attempts >= 36) {
        showProblem(err.message || 'Could not confirm the order.');
      } else {
        timer = setTimeout(poll, manualMode ? 10000 : 3000);
      }
    }
  }

  async function boot() {
    const me = await window.KET.guard();
    if (!me) return;
    const site = await window.KET.api('/api/site').catch(() => ({}));
    manualSite = site;
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

  document.getElementById('copy-order').addEventListener('click', async () => {
    if (!currentOrder) return;
    const ok = await window.KET.copy(currentOrder.number);
    window.KET.toast(ok ? 'Order number copied.' : 'Could not copy the order number.', ok ? 'ok' : 'error');
  });

  claimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    claimError.classList.remove('show');
    claimError.textContent = '';
    claimSubmit.disabled = true;
    const original = claimSubmit.textContent;
    claimSubmit.textContent = 'Submitting…';
    try {
      const data = await window.KET.api(`/api/orders/${encodeURIComponent(orderNumber)}/claim`, {
        method: 'POST',
        body: { reference: claimReference.value.trim(), method: currentOrder?.paymentMethod },
      });
      currentOrder = data.order;
      renderManual(data.order, manualSite);
      window.KET.toast('Claim submitted. The owner will confirm shortly.', 'ok');
      if (!timer) timer = setTimeout(poll, 10000);
    } catch (err) {
      claimError.textContent = err.message || 'Could not submit the claim.';
      claimError.classList.add('show');
    } finally {
      claimSubmit.disabled = false;
      claimSubmit.textContent = original;
    }
  });

  window.addEventListener('beforeunload', () => clearTimeout(timer));
  boot();
})();
