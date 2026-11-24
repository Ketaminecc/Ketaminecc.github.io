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
            stock > 0 ? `${stock} in stock` : '0 in stock · made to order'
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
        <button class="btn ${featured ? 'btn-primary' : 'btn-ghost'} btn-block" type="button"
          data-buy="${window.KET.escape(product.slug)}" data-buy-name="${window.KET.escape(product.name)}">
          Purchase <span class="arrow" aria-hidden="true">→</span>
        </button>
      </article>`;
  }

  // The live catalog once the API answers; the fallback above until then.
  let catalog = null;

  const GAME_LABEL = { cs2: 'Counter-Strike 2' };

  // Purchase starts with the game. The key is minted for one game, so the
  // buyer picks the game first and the plan second; the checkout page also
  // refuses to continue until a game is chosen.
  function installGamePicker() {
    const modal = document.getElementById('game-modal');
    const title = document.getElementById('game-modal-title');
    const note = document.getElementById('game-modal-product');
    const plans = document.getElementById('plan-choices');
    const stepProduct = document.getElementById('modal-step-product');
    const stepGame = document.getElementById('modal-step-game');
    let product = null;
    let game = null;

    function close() {
      if (!modal) return;
      modal.hidden = true;
      document.body.classList.remove('modal-open');
    }

    function showStep(step) {
      const onGame = step === 'game';
      stepProduct.hidden = onGame;
      stepGame.hidden = !onGame;
      title.textContent = onGame ? 'Choose your game' : 'Choose your plan';
      note.textContent = onGame
        ? 'Pick the game first — the key is minted for it.'
        : `${GAME_LABEL[game] || 'Your game'} — pick a plan.`;
      const focus = (onGame ? stepGame : stepProduct).querySelector('button');
      if (focus) focus.focus();
    }

    function renderPlans(selected) {
      const list = catalog && catalog.length ? catalog : FALLBACK_PRODUCTS;
      plans.innerHTML = list
        .map(
          (item) => `
        <button class="plan-choice${item.slug === selected ? ' is-active' : ''}" type="button"
          data-plan="${window.KET.escape(item.slug)}" data-plan-name="${window.KET.escape(item.name)}">
          <span class="plan-choice-name">${window.KET.escape(item.name)}</span>
          <span class="plan-choice-meta">${window.KET.money(item.priceCents, item.currency)} · ${durationLabel(
            item.durationDays
          )}</span>
        </button>`
        )
        .join('');
    }

    function open(slug, name) {
      if (!modal) {
        window.location.assign('/checkout.html');
        return;
      }
      product = { slug, name };
      game = null;
      renderPlans(slug);
      showStep('game');
      modal.hidden = false;
      document.body.classList.add('modal-open');
    }

    document.addEventListener('click', (event) => {
      const buy = event.target.closest('[data-buy]');
      if (buy) {
        event.preventDefault();
        open(buy.dataset.buy, buy.dataset.buyName);
        return;
      }

      const choice = event.target.closest('[data-game-choice]');
      if (choice) {
        event.preventDefault();
        game = choice.dataset.gameChoice;
        renderPlans(product ? product.slug : null);
        showStep('product');
        return;
      }

      const plan = event.target.closest('[data-plan]');
      if (plan) {
        event.preventDefault();
        product = { slug: plan.dataset.plan, name: plan.dataset.planName };
        if (!game) {
          showStep('game');
          return;
        }
        window.location.assign(
          `/checkout.html?product=${encodeURIComponent(product.slug)}&game=${encodeURIComponent(game)}`
        );
        return;
      }

      if (event.target.closest('[data-game-back]')) {
        event.preventDefault();
        showStep('game');
        return;
      }

      if (event.target.closest('[data-game-close]')) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
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
    catalog = products;
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
    installGamePicker();
    load();
  });
})();
