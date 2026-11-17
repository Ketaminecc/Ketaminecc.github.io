'use strict';

(function () {
  const grid = document.getElementById('product-grid');

  function durationLabel(days) {
    if (days === null || days === undefined) return 'LIFETIME';
    if (days % 365 === 0 && days >= 365) return `${days / 365} YEAR${days > 365 ? 'S' : ''}`;
    if (days % 30 === 0) return `${days / 30} MONTH${days > 30 ? 'S' : ''}`;
    return `${days} DAY${days === 1 ? '' : 'S'}`;
  }

  function card(product, index) {
    const featured = index === 1;
    const badge = product.badge || 'LICENSE';
    const features = (product.features || [])
      .map((feature) => `<li>${window.KET.escape(feature)}</li>`)
      .join('');
    return `
      <article class="product-card reveal ${featured ? 'featured' : ''}">
        <div class="plan-top">
          <span class="plan-badge">${window.KET.escape(badge)}</span>
          <span class="plan-duration">${durationLabel(product.durationDays)}</span>
        </div>
        <h3 class="plan-name">${window.KET.escape(product.name)}</h3>
        <div class="plan-price">
          <span class="amount">${window.KET.money(product.priceCents, product.currency)}</span>
          <span class="currency">USD</span>
        </div>
        <ul class="plan-features">${features}</ul>
        <a class="btn ${featured ? 'btn-primary' : 'btn-ghost'} btn-block" href="/checkout.html?product=${encodeURIComponent(product.slug)}">
          Purchase <span class="arrow" aria-hidden="true">→</span>
        </a>
      </article>`;
  }

  async function load() {
    if (!grid) return;
    try {
      const [data, site] = await Promise.all([
        window.KET.api('/api/products'),
        window.KET.api('/api/site').catch(() => ({})),
      ]);
      if (!data.products.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><b>No products live.</b>Check back soon.</div>';
        return;
      }
      grid.innerHTML = data.products.map((product, index) => card(product, index)).join('');
      document.querySelectorAll('#product-grid .reveal').forEach((el) => el.classList.add('in-view'));

      if (site.supportEmail) {
        document.querySelectorAll('[data-support-email]').forEach((el) => {
          el.textContent = site.supportEmail;
          el.href = `mailto:${site.supportEmail}`;
        });
      }
      if (site.discordInvite) {
        document.querySelectorAll('[data-discord-link]').forEach((el) => {
          el.href = site.discordInvite;
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
        });
      }
    } catch (err) {
      grid.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1"><b>Store unavailable.</b>Refresh in a moment.</div>';
      window.KET.toast(err.message || 'Could not load products.', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const year = document.querySelector('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());
    load();
  });
})();
