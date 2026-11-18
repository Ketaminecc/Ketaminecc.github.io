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
  const cryptoBox = document.getElementById('crypto-box');
  const cryptoAssets = document.getElementById('crypto-assets');
  const cryptoUpdated = document.getElementById('crypto-updated');
  const cryptoNote = document.getElementById('crypto-note');
  const cryptoRefresh = document.getElementById('crypto-refresh');
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
  let cryptoLoading = false;
  let renderedCryptoKey = '';

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

  function cryptoTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function cryptoNoteText(crypto) {
    const note = String(crypto?.note || '').trim();
    const warning = 'USDT must be ERC-20 on Ethereum; other networks can lose the funds. Network fees are extra.';
    if (!note) return `Send only on the network shown. ${warning}`;
    return note.toLowerCase().includes('erc-20') || note.toLowerCase().includes('erc20')
      ? note
      : `${note} ${warning}`;
  }

  function cryptoPrice(price) {
    return `$${Number(price).toLocaleString('en-US', {
      maximumFractionDigits: Number(price) < 2 ? 4 : 2,
    })}`;
  }

  function cryptoCard(asset, fallbackAmount = null) {
    const esc = window.KET.escape;
    const amountLine = fallbackAmount
      ? `Send <span>${esc(fallbackAmount)}</span> worth`
      : `${esc(asset.amountText)} <span>${esc(asset.code)}</span>`;
    const detail = fallbackAmount
      ? 'Live rate unavailable — send the USD equivalent.'
      : `≈ ${window.KET.money(Math.round(asset.usdValue * 100), 'usd')} · 1 ${esc(
          asset.code
        )} = ${cryptoPrice(asset.usdPrice)}`;
    const copyAmount = fallbackAmount
      ? ''
      : `<button class="btn btn-subtle btn-small" type="button" data-copy="${esc(
          asset.amountText
        )}" data-label="Amount">Copy amount</button>`;
    return `<article class="crypto-asset">
      <div class="crypto-asset-head">
        <span class="crypto-code">${esc(asset.code)}</span>
        <span class="crypto-name">${esc(asset.name)} · ${esc(asset.network)}</span>
      </div>
      <div class="crypto-amount">${amountLine}</div>
      <div class="crypto-usd">${detail}</div>
      <code class="crypto-address">${esc(asset.address)}</code>
      <div class="crypto-buttons">
        ${copyAmount}
        <button class="btn btn-subtle btn-small" type="button" data-copy="${esc(
          asset.address
        )}" data-label="Address">Copy address</button>
      </div>
    </article>`;
  }

  function fallbackAssets(crypto) {
    return [
      crypto.btc && {
        code: 'BTC',
        name: 'Bitcoin',
        network: 'Bitcoin network',
        address: crypto.btc,
      },
      crypto.eth && {
        code: 'ETH',
        name: 'Ethereum',
        network: 'Ethereum network',
        address: crypto.eth,
      },
      crypto.usdt && {
        code: 'USDT',
        name: 'Tether',
        network: 'Ethereum (ERC-20)',
        address: crypto.usdt,
      },
    ].filter(Boolean);
  }

  function paintCrypto(data, crypto, order) {
    const assets = Array.isArray(data.assets) ? data.assets : [];
    if (!assets.length) {
      paintCryptoFallback(crypto, order);
      return;
    }
    cryptoAssets.innerHTML = assets.map((asset) => cryptoCard(asset)).join('');
    cryptoUpdated.textContent = `Rates updated ${cryptoTime(data.updatedAt)}${
      data.stale ? ' · cached' : ''
    }`;
    cryptoNote.hidden = false;
    cryptoNote.textContent = cryptoNoteText(crypto);
  }

  function paintCryptoFallback(crypto, order) {
    const assets = fallbackAssets(crypto);
    const amount = window.KET.money(order.amountCents, order.currency);
    cryptoAssets.innerHTML = assets.length
      ? assets.map((asset) => cryptoCard(asset, amount)).join('')
      : '';
    cryptoUpdated.textContent = assets.length ? 'Live rates unavailable' : '';
    cryptoNote.hidden = false;
    cryptoNote.textContent = cryptoNoteText(crypto);
  }

  async function renderCrypto(order, manual, force = false) {
    const crypto = (manual && manual.crypto) || {};
    const key = `${order.number}:${order.amountCents}`;
    cryptoBox.hidden = false;
    if (!force && renderedCryptoKey === key) return;
    if (!fallbackAssets(crypto).length) {
      renderedCryptoKey = key;
      cryptoAssets.innerHTML = '';
      cryptoUpdated.textContent = '';
      cryptoNote.hidden = false;
      cryptoNote.textContent = cryptoNoteText(crypto);
      return;
    }
    if (cryptoLoading) return;
    cryptoLoading = true;
    cryptoAssets.innerHTML = '<div class="crypto-loading">Fetching live BTC / ETH / USDT amounts…</div>';
    cryptoUpdated.textContent = 'Fetching live rates…';
    try {
      const data = await window.KET.api(`/api/crypto/rates?amountCents=${order.amountCents}`);
      paintCrypto(data, crypto, order);
      renderedCryptoKey = key;
    } catch (err) {
      paintCryptoFallback(crypto, order);
      renderedCryptoKey = key;
    } finally {
      cryptoLoading = false;
    }
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
    sub.textContent =
      method === 'crypto'
        ? `Send ${amount} worth of BTC, ETH, or USDT using one of the amounts below.`
        : `Send ${amount} with ${methodLabel}, include your order number, then confirm below.`;
    document.getElementById('success-icon').textContent = '$';
    manualOrder.textContent = order.number;
    manualAmount.textContent = amount;
    manualInstructions.textContent =
      manual.instructions ||
      'Pay the exact amount, include your order number in the note, then submit the transaction ID or open a Discord ticket.';

    manualLinks.innerHTML = '';
    cryptoBox.hidden = true;

    if (method === 'cashapp' && manual.cashapp) {
      addManualLink(`https://cash.app/${manual.cashapp}/${dollars}`, `Pay ${amount} with Cash App`);
    } else if (method === 'paypal' && manual.paypal) {
      addManualLink(`${String(manual.paypal).replace(/\/+$/, '')}/${dollars}`, `Pay ${amount} with PayPal`);
    } else if (method === 'crypto') {
      const crypto = manual.crypto || {};
      if (crypto.btc || crypto.eth || crypto.usdt || crypto.note) {
        cryptoBox.hidden = false;
        renderCrypto(order, manual);
      }
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

  cryptoAssets.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    const ok = await window.KET.copy(btn.getAttribute('data-copy') || '');
    window.KET.toast(ok ? `${btn.dataset.label || 'Value'} copied.` : 'Could not copy.', ok ? 'ok' : 'error');
  });

  cryptoRefresh.addEventListener('click', () => {
    if (currentOrder) renderCrypto(currentOrder, manualSite?.manual || {}, true);
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
