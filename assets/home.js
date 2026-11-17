'use strict';

(function () {
  const grid = document.getElementById('product-grid');

  // Catalog fallback so the storefront still renders when the API is unreachable.
  const FALLBACK_PRODUCTS = [
    {
      slug: 'weekly',
      name: 'Weekly License',
      tagline: 'Short cycle access, delivered instantly.',
      priceCents: 599,
      currency: 'usd',
      durationDays: 7,
      badge: 'STARTER',
      features: ['Full access to core features', 'Instant encrypted key delivery', 'Standard support channel'],
    },
    {
      slug: 'monthly',
      name: 'Monthly License',
      tagline: 'The working plan for daily use.',
      priceCents: 1599,
      currency: 'usd',
      durationDays: 30,
      badge: 'MOST POPULAR',
      features: [
        'Full access to core features',
        'Instant encrypted key delivery',
        'Priority support channel',
        'Free minor updates',
      ],
    },
    {
      slug: 'lifetime',
      name: 'Lifetime License',
      tagline: 'One payment. Permanent access.',
      priceCents: 3000,
      currency: 'usd',
      durationDays: null,
      badge: 'BEST VALUE',
      features: [
        'Full access to core features',
        'All future updates included',
        '1-on-1 private developer line',
        'Direct help & priority fixes',
      ],
    },
  ];

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
    const stock = typeof product.stock === 'number' ? product.stock : null;
    const stockLine =
      stock === null
        ? ''
        : `<div class="plan-stock ${stock > 0 ? 'available' : 'empty'}"><span class="stock-dot" aria-hidden="true"></span>${
            stock > 0 ? `${stock} in stock` : 'Made to order'
          }</div>`;
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
        ${stockLine}
        <ul class="plan-features">${features}</ul>
        <a class="btn ${featured ? 'btn-primary' : 'btn-ghost'} btn-block" href="/checkout.html?product=${encodeURIComponent(product.slug)}">
          Purchase <span class="arrow" aria-hidden="true">→</span>
        </a>
      </article>`;
  }

  async function load() {
    if (!grid) return;
    const [productsResult, siteResult] = await Promise.allSettled([
      window.KET.api('/api/products'),
      window.KET.api('/api/site'),
    ]);
    const site = siteResult.status === 'fulfilled' && siteResult.value ? siteResult.value : {};
    let products;
    if (productsResult.status === 'fulfilled' && productsResult.value && Array.isArray(productsResult.value.products)) {
      products = productsResult.value.products;
    } else {
      console.warn(
        'Product API unavailable — showing the static catalog.',
        productsResult.status === 'rejected' ? productsResult.reason : productsResult.value
      );
      products = FALLBACK_PRODUCTS;
    }
    if (!products.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><b>No products live.</b>Check back soon.</div>';
      return;
    }
    grid.innerHTML = products.map((product, index) => card(product, index)).join('');
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
  }

  document.addEventListener('DOMContentLoaded', () => {
    const year = document.querySelector('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());
    load();
  });
})();
