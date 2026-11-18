'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  const errorBox = document.getElementById('checkout-error');
  const payBtn = document.getElementById('pay-btn');
  const payLabel = document.getElementById('pay-label');
  let product = null;
  let payments = 'stripe';
  let manual = null;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  function durationLabel(days) {
    if (days === null || days === undefined) return 'Lifetime';
    if (days % 30 === 0) return `${days / 30} month${days > 30 ? 's' : ''}`;
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  const methodMeta = {
    cashapp: ['Cash App', 'Send to'],
    paypal: ['PayPal', 'Pay with your PayPal account'],
    crypto: ['Crypto', 'BTC / ETH / USDT · live amount on the payment page'],
  };

  function renderManualMethods() {
    const box = document.getElementById('manual-methods');
    const methods = manual?.methods || [];
    if (!methods.length) {
      box.hidden = true;
      showError('No manual payment methods are configured yet. Contact support.');
      payBtn.disabled = true;
      return;
    }
    box.innerHTML = methods
      .map((method, index) => {
        const [label, hint] = methodMeta[method] || [method, ''];
        const detail =
          method === 'cashapp' && manual.cashapp ? `${hint} ${manual.cashapp}` : hint;
        return `<label class="pay-method">
            <input type="radio" name="pay-method" value="${method}" ${index === 0 ? 'checked' : ''}>
            <span class="pay-method-copy"><b>${label}</b><small>${detail}</small></span>
          </label>`;
      })
      .join('');
    box.hidden = false;
  }

  function render(products, site) {
    payments = site.payments || 'disabled';
    manual = site.manual || null;
    const slug = params.get('product');
    product = products.find((p) => p.slug === slug) || products[0];

    if (!product) {
      showError('No plans are available right now.');
      payBtn.disabled = true;
      return;
    }

    document.getElementById('summary-name').textContent = product.name;
    document.getElementById('summary-tagline').textContent = product.tagline || '';
    document.getElementById('summary-price').textContent = window.KET.money(product.priceCents, product.currency);
    document.getElementById('summary-total').textContent = window.KET.money(product.priceCents, product.currency);
    document.getElementById('summary-duration').textContent = durationLabel(product.durationDays);
    document.title = `Checkout · ${product.name} — Ketamine.cc`;

    if (site.supportEmail) {
      document.querySelectorAll('[data-support-email]').forEach((el) => {
        el.textContent = site.supportEmail;
        el.href = `mailto:${site.supportEmail}`;
      });
    }

    const demoBanner = document.getElementById('demo-banner');
    if (payments === 'demo') {
      demoBanner.hidden = false;
      payLabel.textContent = 'Complete demo checkout';
      document.getElementById('payment-mode').textContent = 'Demo';
    } else if (payments === 'disabled') {
      showError('Payments are not configured yet. Contact support and we will finish the order manually.');
      payBtn.disabled = true;
      payLabel.textContent = 'Payments offline';
      document.getElementById('payment-mode').textContent = 'Offline';
    } else if (payments === 'manual') {
      document.getElementById('manual-banner').hidden = false;
      document.getElementById('card-data-line').hidden = true;
      document.getElementById('payment-mode').textContent = 'Manual';
      document.getElementById('payment-note').textContent = 'Pay externally · key issued after confirmation';
      payLabel.textContent = 'Create order & pay';
      renderManualMethods();
    } else {
      document.getElementById('payment-mode').textContent = 'Stripe';
    }

    if (params.get('canceled') === '1') document.getElementById('cancel-banner').hidden = false;
  }

  async function boot() {
    const me = await window.KET.guard();
    if (!me) return;

    const user = me.user;
    document.getElementById('buyer-avatar').textContent = window.KET.initials(user.displayName || user.email);
    document.querySelectorAll('[data-user-name]').forEach((el) => (el.textContent = user.displayName || 'Account holder'));
    document.querySelectorAll('[data-user-email]').forEach((el) => (el.textContent = user.email));

    try {
      const [productData, site] = await Promise.all([window.KET.api('/api/products'), window.KET.api('/api/site')]);
      render(productData.products, site);
    } catch (err) {
      showError(err.message || 'Could not load checkout.');
      payBtn.disabled = true;
    }
  }

  payBtn.addEventListener('click', async () => {
    if (!product) return;
    errorBox.classList.remove('show');
    const method =
      payments === 'manual' ? document.querySelector('input[name="pay-method"]:checked')?.value : null;
    if (payments === 'manual' && !method) {
      showError('Choose a payment method first.');
      return;
    }
    payBtn.disabled = true;
    payBtn.classList.add('is-loading');
    const original = payLabel.textContent;
    payLabel.textContent =
      payments === 'demo' ? 'Issuing license…' : payments === 'manual' ? 'Creating order…' : 'Opening Stripe…';

    try {
      const result = await window.KET.api('/api/checkout', {
        method: 'POST',
        body: { productId: product.id, method },
      });
      if (result.mode === 'manual' && result.order?.number) {
        window.location.assign(`/checkout-success.html?order=${encodeURIComponent(result.order.number)}`);
        return;
      }
      if (!result.url) throw new Error('Checkout did not return a destination.');
      window.location.assign(result.url);
    } catch (err) {
      payBtn.disabled = false;
      payBtn.classList.remove('is-loading');
      payLabel.textContent = original;
      showError(err.message || 'Could not start checkout. Try again.');
    }
  });

  document.getElementById('switch-account').addEventListener('click', () => {
    window.KET.logout();
  });

  boot();
})();
