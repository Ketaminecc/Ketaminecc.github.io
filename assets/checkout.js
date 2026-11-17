'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  const errorBox = document.getElementById('checkout-error');
  const payBtn = document.getElementById('pay-btn');
  const payLabel = document.getElementById('pay-label');
  let product = null;
  let payments = 'stripe';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  function durationLabel(days) {
    if (days === null || days === undefined) return 'Lifetime';
    if (days % 30 === 0) return `${days / 30} month${days > 30 ? 's' : ''}`;
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  function render(products, site) {
    payments = site.payments || 'disabled';
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
    payBtn.disabled = true;
    payBtn.classList.add('is-loading');
    const original = payLabel.textContent;
    payLabel.textContent = payments === 'demo' ? 'Issuing license…' : 'Opening Stripe…';

    try {
      const result = await window.KET.api('/api/checkout', {
        method: 'POST',
        body: { productId: product.id },
      });
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
