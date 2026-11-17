'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) => window.KET.escape(value);
  const money = (cents, currency = 'usd') => window.KET.money(cents, currency);
  const date = (ms, withTime = false) => window.KET.date(ms, withTime);

  const login = $('#admin-login');
  const shell = $('#admin-shell');
  const loginError = $('#admin-login-error');

  const state = {
    view: 'overview',
    products: [],
    orders: [],
    licenses: [],
    users: [],
    generatedKeys: [],
  };

  const viewMeta = {
    overview: ['Overview', 'Control plane · encrypted purchase audit'],
    orders: ['Orders', 'Payments, fulfillment, refunds, and revocation'],
    licenses: ['Licenses', 'Restock, inspect, revoke, or blacklist keys'],
    products: ['Products', 'Storefront plans and Stripe pricing'],
    customers: ['Customers', 'Accounts, spend, and access'],
    blacklist: ['Blacklist', 'Block emails, keys, IPs, and Discord IDs'],
    audit: ['Audit log', 'Administrative actions'],
    settings: ['Settings', 'Storefront, integrations, and verification'],
  };

  // ── Helpers ───────────────────────────────────────────────────────────

  function pill(status, map) {
    const cls = (map || {})[status] || 'neutral';
    return `<span class="pill ${cls}">${esc(status)}</span>`;
  }

  const paymentLabels = { cashapp: 'Cash App', paypal: 'PayPal', crypto: 'Crypto', stripe: 'Stripe', demo: 'Demo' };

  const orderPill = (status) =>
    pill(status, {
      paid: 'ok',
      pending: 'warn',
      awaiting_payment: 'warn',
      refunded: 'neutral',
      expired: 'neutral',
      failed: 'bad',
    });
  const licensePill = (status) =>
    pill(status, { active: 'ok', stock: 'warn', revoked: 'bad', blacklisted: 'bad', expired: 'neutral', missing: 'neutral' });

  function showLogin() {
    shell.hidden = true;
    login.hidden = false;
    const secret = $('#admin-secret');
    if (secret) setTimeout(() => secret.focus(), 60);
  }

  function showShell() {
    login.hidden = true;
    shell.hidden = false;
  }

  async function adminApi(path, options = {}) {
    try {
      return await window.KET.api(path, options);
    } catch (err) {
      if (err.status === 401) {
        showLogin();
        window.KET.toast('Admin session expired. Unlock again.', 'warn');
      }
      throw err;
    }
  }

  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModals() {
    $$('.modal.open').forEach((modal) => modal.classList.remove('open'));
    document.body.style.overflow = '';
  }

  function showError(id, message) {
    const box = document.getElementById(id);
    if (!box) return;
    box.textContent = message;
    box.classList.add('show');
  }

  function clearError(id) {
    const box = document.getElementById(id);
    if (box) box.classList.remove('show');
  }

  function emptyRow(cols, text) {
    return `<tr><td colspan="${cols}" class="table-empty">${esc(text)}</td></tr>`;
  }

  // ── Navigation ────────────────────────────────────────────────────────

  const loaders = {
    overview: loadOverview,
    orders: loadOrders,
    licenses: loadLicenses,
    products: loadProductsView,
    customers: loadCustomers,
    blacklist: loadBlacklist,
    audit: loadAudit,
    settings: loadSettings,
  };

  async function loadView(view) {
    state.view = view;
    $$('.admin-nav [data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    $$('.admin-view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    const [title, sub] = viewMeta[view] || ['Admin', ''];
    $('#admin-title').textContent = title;
    $('#admin-sub').textContent = sub;
    try {
      await loaders[view]();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Failed to load section.', 'error');
    }
  }

  // ── Overview ──────────────────────────────────────────────────────────

  async function loadOverview() {
    const data = await adminApi('/api/admin/overview');
    const s = data.stats;
    const stats = [
      ['Revenue · 30d', money(s.revenue30d), 'paid orders'],
      ['Orders · 30d', s.orders30d, 'completed'],
      ['Active licenses', s.activeLicenses, 'currently valid'],
      ['Expiring · 7d', s.expiringSoon, 'renewal window'],
      ['Customers', s.users, 'registered'],
      ['Pending / refunds', `${s.pendingOrders} / ${s.refunds30d}`, 'last 30d'],
    ];
    $('#overview-stats').innerHTML = stats
      .map(
        ([label, value, note]) =>
          `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`
      )
      .join('');

    const body = $('#overview-orders');
    if (!data.recent.length) {
      body.innerHTML = emptyRow(7, 'No orders yet.');
      return;
    }
    body.innerHTML = data.recent
      .map(
        (order) => `
        <tr>
          <td class="num">${esc(order.number)}</td>
          <td>${esc(order.email)}</td>
          <td>${esc(order.product)}</td>
          <td class="num">${money(order.amountCents, order.currency)}</td>
          <td>${orderPill(order.status)}</td>
          <td class="dim">${date(order.createdAt, true)}</td>
          <td><button class="btn btn-subtle btn-small" type="button" data-order-view="${esc(order.number)}">View</button></td>
        </tr>`
      )
      .join('');
  }

  // ── Orders ────────────────────────────────────────────────────────────

  async function loadOrders() {
    const q = encodeURIComponent($('#order-search').value.trim());
    const status = encodeURIComponent($('#order-status').value);
    const data = await adminApi(`/api/admin/orders?q=${q}&status=${status}`);
    state.orders = data.orders;
    const body = $('#orders-body');
    if (!data.orders.length) {
      body.innerHTML = emptyRow(8, 'No orders match this filter.');
      return;
    }
    body.innerHTML = data.orders
      .map((order) => {
        const manual = Boolean(order.paymentMethod && order.paymentMethod !== 'stripe' && order.paymentMethod !== 'demo');
        return `
        <tr>
          <td class="num">${esc(order.number)}${
            manual ? `<div class="dim" style="font-size:.65rem">${esc(paymentLabels[order.paymentMethod] || order.paymentMethod)}</div>` : ''
          }</td>
          <td>${esc(order.email)}</td>
          <td>${esc(order.product)}</td>
          <td class="num">${money(order.amountCents, order.currency)}</td>
          <td>${orderPill(order.status)}</td>
          <td>${order.licenseStatus ? licensePill(order.licenseStatus) : '<span class="dim">—</span>'}</td>
          <td class="dim">${date(order.createdAt, true)}</td>
          <td>
            <div class="actions">
              <button class="btn btn-subtle btn-small" type="button" data-order-view="${esc(order.number)}">View</button>
              ${
                order.status === 'awaiting_payment'
                  ? `<button class="btn btn-primary btn-small" type="button" data-order-confirm="${esc(order.number)}">Confirm</button>
                     <button class="btn btn-ghost btn-small" type="button" data-order-cancel="${esc(order.number)}">Cancel</button>`
                  : ''
              }
              ${
                order.status === 'paid'
                  ? `<button class="btn btn-danger btn-small" type="button" data-order-refund="${esc(order.number)}">${
                      manual ? 'Mark refunded' : 'Refund'
                    }</button>`
                  : ''
              }
              ${
                order.status === 'paid'
                  ? `<button class="btn btn-subtle btn-small" type="button" data-order-revoke="${esc(order.number)}">Revoke</button>`
                  : ''
              }
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  async function openOrder(number) {
    $('#order-detail').innerHTML = '<div class="table-empty"><span class="spinner" style="margin-inline:auto"></span></div>';
    $('#order-modal-title').textContent = `Order ${number}`;
    $('#order-modal-sub').textContent = 'Decrypted purchase record';
    openModal('order-modal');
    try {
      const data = await adminApi(`/api/admin/orders/${encodeURIComponent(number)}`);
      const o = data.order;
      const manual = Boolean(o.paymentMethod && o.paymentMethod !== 'stripe' && o.paymentMethod !== 'demo');
      const licenseRows = data.licenses.length
        ? data.licenses
            .map(
              (license) => `
              <div class="license-item" style="margin-top:.6rem">
                <div class="license-top">
                  <h4>${esc(license.productName || o.product)}</h4>
                  ${licensePill(license.status)}
                </div>
                <div class="license-key">
                  <code>${esc(license.key || 'unavailable')}</code>
                  <button class="icon-btn" type="button" data-copy="${esc(license.key || '')}" title="Copy key">⧉</button>
                </div>
                <div class="license-meta">
                  <span>Issued <b>${date(license.issuedAt)}</b></span>
                  <span>Expires <b>${license.expiresAt ? date(license.expiresAt) : 'Never'}</b></span>
                </div>
              </div>`
            )
            .join('')
        : '<p class="form-note" style="margin-top:.6rem">No license linked to this order.</p>';

      $('#order-detail').innerHTML = `
        <div class="summary-line"><span>Purchase ID</span><span class="mono">${esc(o.number)}</span></div>
        <div class="summary-line"><span>Status</span><span>${orderPill(o.status)}</span></div>
        <div class="summary-line"><span>Customer</span><span>${esc(o.customerName || '—')} · ${esc(o.email)}</span></div>
        <div class="summary-line"><span>Product</span><span>${esc(o.product)}</span></div>
        <div class="summary-line"><span>Amount</span><span>${money(o.amountCents, o.currency)}</span></div>
        <div class="summary-line"><span>Payment method</span><span>${esc(paymentLabels[o.paymentMethod] || o.paymentMethod || '—')}</span></div>
        <div class="summary-line"><span>Claim reference</span><span>${esc(o.paymentRef || '—')}</span></div>
        <div class="summary-line"><span>Claimed</span><span>${o.paymentClaimedAt ? date(o.paymentClaimedAt, true) : '—'}</span></div>
        <div class="summary-line"><span>Created</span><span>${date(o.createdAt, true)}</span></div>
        <div class="summary-line"><span>Paid</span><span>${o.paidAt ? date(o.paidAt, true) : '—'}</span></div>
        <div class="summary-line"><span>Expires</span><span>${o.expiresAt ? date(o.expiresAt) : 'Never'}</span></div>
        <div class="summary-line"><span>Discord log</span><span class="mono">${esc(o.discordStatus || 'not sent')}</span></div>
        <div class="summary-line"><span>Stripe session</span><span class="mono" style="word-break:break-all">${esc(o.stripeSessionId || '—')}</span></div>
        <div class="summary-line"><span>Payment intent</span><span class="mono" style="word-break:break-all">${esc(o.paymentIntent || '—')}</span></div>
        <div class="summary-line"><span>Account flagged</span><span>${o.blacklisted ? pill('blacklisted', { blacklisted: 'bad' }) : 'No'}</span></div>
        <hr class="hr">
        <h3 style="font-size:.85rem;margin-bottom:.4rem">Licenses</h3>
        ${licenseRows}
        <div class="actions" style="margin-top:1.1rem;justify-content:flex-end">
          ${
            o.status === 'awaiting_payment'
              ? `<button class="btn btn-primary btn-small" type="button" data-order-confirm="${esc(o.number)}">Confirm payment</button>
                 <button class="btn btn-ghost btn-small" type="button" data-order-cancel="${esc(o.number)}">Cancel</button>`
              : ''
          }
          ${o.status === 'paid' ? `<button class="btn btn-subtle btn-small" type="button" data-order-revoke="${esc(o.number)}">Revoke keys</button>` : ''}
          ${
            o.status === 'paid'
              ? `<button class="btn btn-danger btn-small" type="button" data-order-refund="${esc(o.number)}">${
                  manual ? 'Mark refunded' : 'Refund order'
                }</button>`
              : ''
          }
          <button class="btn btn-ghost btn-small" type="button" data-close-modal>Close</button>
        </div>`;
    } catch (err) {
      $('#order-detail').innerHTML = `<div class="empty-state">${esc(err.message || 'Could not load order.')}</div>`;
    }
  }

  async function refundOrder(number) {
    const order = state.orders.find((item) => item.number === number);
    const manual = Boolean(order && order.paymentMethod && order.paymentMethod !== 'stripe' && order.paymentMethod !== 'demo');
    if (
      !window.confirm(
        `${manual ? 'Mark' : 'Refund'} ${number}? The license is revoked and this cannot be undone.${
          manual ? ' Refund the buyer in Cash App / PayPal / crypto yourself.' : ''
        }`
      )
    ) {
      return;
    }
    try {
      const result = await adminApi(`/api/admin/orders/${encodeURIComponent(number)}/refund`, {
        method: 'POST',
        body: {},
      });
      window.KET.toast(`${manual ? 'Marked' : 'Refunded'} ${number}. ${result.revoked} license(s) revoked.`, 'ok');
      closeModals();
      await loadView(state.view);
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Refund failed.', 'error');
    }
  }

  async function confirmOrder(number) {
    if (!window.confirm(`Confirm payment for ${number}? This issues the license immediately.`)) return;
    try {
      const result = await adminApi(`/api/admin/orders/${encodeURIComponent(number)}/confirm`, {
        method: 'POST',
        body: {},
      });
      window.KET.toast(`Payment confirmed. ${result.keyPreview ? `Key ${result.keyPreview} issued.` : 'License issued.'}`, 'ok');
      closeModals();
      await loadView(state.view);
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Could not confirm payment.', 'error');
    }
  }

  async function cancelOrder(number) {
    if (!window.confirm(`Cancel ${number}? The buyer can create a new order.`)) return;
    try {
      await adminApi(`/api/admin/orders/${encodeURIComponent(number)}/cancel`, { method: 'POST', body: {} });
      window.KET.toast(`Order ${number} cancelled.`, 'ok');
      closeModals();
      await loadView(state.view);
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Could not cancel the order.', 'error');
    }
  }

  async function revokeOrder(number) {
    if (!window.confirm(`Revoke every license on ${number}? Access stops immediately.`)) return;
    try {
      const result = await adminApi(`/api/admin/orders/${encodeURIComponent(number)}/revoke`, {
        method: 'POST',
        body: {},
      });
      window.KET.toast(`Revoked ${result.revoked} license(s).`, 'ok');
      closeModals();
      await loadView(state.view);
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Revoke failed.', 'error');
    }
  }

  // ── Licenses ──────────────────────────────────────────────────────────

  async function ensureProducts() {
    if (state.products.length) return state.products;
    const data = await adminApi('/api/admin/products');
    state.products = data.products;
    return state.products;
  }

  function fillProductSelect() {
    const select = $('#license-product');
    if (!select) return;
    const current = select.value;
    select.innerHTML = state.products
      .map(
        (product) =>
          `<option value="${esc(product.id)}">${esc(product.name)}${product.active ? '' : ' (hidden)'} — ${money(
            product.priceCents,
            product.currency
          )}</option>`
      )
      .join('');
    if (current && state.products.some((p) => p.id === current)) select.value = current;
  }

  async function loadLicenses() {
    if (!state.products.length) await ensureProducts();
    fillProductSelect();
    const q = encodeURIComponent($('#license-search').value.trim());
    const data = await adminApi(`/api/admin/licenses?q=${q}`);
    state.licenses = data.licenses;
    const stockLine = $('#license-stock');
    if (stockLine) {
      const stock = data.stock || [];
      stockLine.textContent = stock.length
        ? `In stock: ${stock.map((row) => `${row.productName} ${row.count}`).join(' · ')}`
        : 'In stock: 0. Checkout will generate keys on demand.';
    }
    const body = $('#licenses-body');
    if (!data.licenses.length) {
      body.innerHTML = emptyRow(6, 'No licenses found.');
      return;
    }
    body.innerHTML = data.licenses
      .map(
        (license) => `
        <tr>
          <td class="num key-cell">${esc(license.key || license.preview)}</td>
          <td>${esc(license.productName || '—')}</td>
          <td>${license.status === 'stock' ? '<span class="dim">In stock</span>' : esc(license.email || license.note || 'unassigned')}</td>
          <td>${licensePill(license.status)}</td>
          <td class="dim">${license.expiresAt ? date(license.expiresAt) : license.status === 'stock' ? `${license.durationDays || '∞'} days after purchase` : 'Never'}</td>
          <td>
            <div class="actions">
              <button class="btn btn-subtle btn-small" type="button" data-copy="${esc(license.key || '')}">Copy</button>
              ${license.status === 'active' || license.status === 'stock' ? `<button class="btn btn-subtle btn-small" type="button" data-license-revoke="${esc(license.id)}">Revoke</button>` : ''}
              ${license.status !== 'blacklisted' ? `<button class="btn btn-danger btn-small" type="button" data-license-blacklist="${esc(license.id)}">Blacklist</button>` : ''}
            </div>
          </td>
        </tr>`
      )
      .join('');
  }

  async function revokeLicense(id) {
    if (!window.confirm('Revoke this license? The customer loses access immediately.')) return;
    try {
      await adminApi(`/api/admin/licenses/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
      window.KET.toast('License revoked.', 'ok');
      await loadLicenses();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Revoke failed.', 'error');
    }
  }

  async function blacklistLicense(id) {
    if (!window.confirm('Blacklist this key? It will fail validation permanently.')) return;
    try {
      await adminApi(`/api/admin/licenses/${encodeURIComponent(id)}/blacklist`, {
        method: 'POST',
        body: { reason: 'Blacklisted from admin dashboard' },
      });
      window.KET.toast('License blacklisted.', 'ok');
      await loadLicenses();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Blacklist failed.', 'error');
    }
  }

  async function generateLicenses(event) {
    event.preventDefault();
    clearError('license-error');
    const productId = $('#license-product').value;
    const quantity = Math.min(500, Math.max(1, Number($('#license-quantity').value) || 1));
    const durationRaw = $('#license-duration').value.trim();
    const note = $('#license-note').value.trim();
    const btn = $('#license-submit');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const body = { productId, quantity, note };
      if (durationRaw) body.durationDays = /^\d+$/.test(durationRaw) ? Number(durationRaw) : durationRaw;
      const result = await adminApi('/api/admin/licenses/generate', { method: 'POST', body });
      state.generatedKeys = result.keys;
      $('#license-result').hidden = false;
      $('#generated-keys').innerHTML = result.keys
        .map(
          (key) => `
          <div class="generated-key">
            <code>${esc(key.key)}</code>
            <button class="icon-btn" type="button" data-copy="${esc(key.key)}" title="Copy">⧉</button>
          </div>`
        )
        .join('');
      window.KET.toast(`${result.keys.length} keys added to stock for ${result.product}.`, 'ok');
      await loadLicenses();
    } catch (err) {
      if (err.status !== 401) showError('license-error', err.message || 'Restock failed.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate stock';
    }
  }

  // ── Products ──────────────────────────────────────────────────────────

  async function loadProductsView() {
    const data = await adminApi('/api/admin/products');
    state.products = data.products;
    fillProductSelect();
    const body = $('#products-body');
    if (!data.products.length) {
      body.innerHTML = emptyRow(7, 'No products yet.');
      return;
    }
    body.innerHTML = data.products
      .map(
        (product) => `
        <tr>
          <td><b>${esc(product.name)}</b><br><span class="dim">${esc(product.slug)}</span></td>
          <td class="num">${money(product.priceCents, product.currency)}</td>
          <td>${product.durationDays ? `${product.durationDays} days` : 'Lifetime'}</td>
          <td>${product.badge ? `<span class="pill neutral">${esc(product.badge)}</span>` : '<span class="dim">—</span>'}</td>
          <td>${product.active ? '<span class="pill ok">live</span>' : '<span class="pill neutral">hidden</span>'}</td>
          <td class="dim">${date(product.updatedAt)}</td>
          <td><button class="btn btn-subtle btn-small" type="button" data-product-edit="${esc(product.id)}">Edit</button></td>
        </tr>`
      )
      .join('');
  }

  function openProductModal(product) {
    clearError('product-error');
    $('#product-modal-title').textContent = product ? `Edit ${product.name}` : 'New product';
    $('#product-id').value = product ? product.id : '';
    $('#product-name').value = product ? product.name : '';
    $('#product-tagline').value = product ? product.tagline || '' : '';
    $('#product-price').value = product ? (product.priceCents / 100).toFixed(2) : '';
    $('#product-duration').value = product && product.durationDays ? product.durationDays : '';
    $('#product-badge').value = product ? product.badge || '' : '';
    $('#product-note').value = product ? product.note || '' : '';
    $('#product-sort').value = product ? product.sort : state.products.length + 1;
    $('#product-features').value = product ? (product.features || []).join('\n') : '';
    $('#product-description').value = product ? product.description || '' : '';
    $('#product-active').checked = product ? product.active : true;
    openModal('product-modal');
    setTimeout(() => $('#product-name').focus(), 80);
  }

  async function saveProduct(event) {
    event.preventDefault();
    clearError('product-error');
    const id = $('#product-id').value;
    const durationRaw = $('#product-duration').value.trim();
    const body = {
      name: $('#product-name').value.trim(),
      tagline: $('#product-tagline').value.trim(),
      priceCents: Math.round(Number($('#product-price').value) * 100),
      durationDays: durationRaw ? Number(durationRaw) : null,
      badge: $('#product-badge').value.trim(),
      note: $('#product-note').value.trim(),
      sort: Number($('#product-sort').value) || 0,
      features: $('#product-features').value,
      description: $('#product-description').value.trim(),
      active: $('#product-active').checked,
    };
    const btn = $('#product-submit');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      if (id) await adminApi(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'PUT', body });
      else await adminApi('/api/admin/products', { method: 'POST', body });
      closeModals();
      window.KET.toast(id ? 'Product updated.' : 'Product created.', 'ok');
      await loadProductsView();
    } catch (err) {
      if (err.status !== 401) showError('product-error', err.message || 'Could not save product.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save product';
    }
  }

  // ── Customers ─────────────────────────────────────────────────────────

  async function loadCustomers() {
    const q = encodeURIComponent($('#customer-search').value.trim());
    const data = await adminApi(`/api/admin/users?q=${q}`);
    state.users = data.users;
    const body = $('#customers-body');
    if (!data.users.length) {
      body.innerHTML = emptyRow(7, 'No customers found.');
      return;
    }
    body.innerHTML = data.users
      .map(
        (user) => `
        <tr>
          <td><b>${esc(user.displayName || '—')}</b><br><span class="dim">${esc(user.email)}</span></td>
          <td class="num">${user.paidOrders}</td>
          <td class="num">${money(user.revenueCents)}</td>
          <td class="num">${user.activeLicenses}</td>
          <td class="dim">${date(user.createdAt)}</td>
          <td class="dim">${user.lastLoginAt ? date(user.lastLoginAt, true) : '—'}</td>
          <td>
            ${
              user.blacklisted
                ? `<button class="btn btn-subtle btn-small" type="button" data-user-unblacklist="${esc(user.id)}">Unblacklist</button>`
                : `<button class="btn btn-danger btn-small" type="button" data-user-blacklist="${esc(user.id)}">Blacklist</button>`
            }
          </td>
        </tr>`
      )
      .join('');
  }

  async function setUserBlacklist(id, blacklist) {
    const verb = blacklist ? 'Blacklist' : 'Unblacklist';
    if (!window.confirm(`${verb} this customer? ${blacklist ? 'Active licenses will be revoked.' : ''}`)) return;
    try {
      await adminApi(`/api/admin/users/${encodeURIComponent(id)}/${blacklist ? 'blacklist' : 'unblacklist'}`, {
        method: 'POST',
        body: {},
      });
      window.KET.toast(`Customer ${blacklist ? 'blacklisted' : 'restored'}.`, 'ok');
      await loadCustomers();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Action failed.', 'error');
    }
  }

  // ── Blacklist ─────────────────────────────────────────────────────────

  async function loadBlacklist() {
    const data = await adminApi('/api/admin/blacklist');
    const body = $('#blacklist-body');
    if (!data.entries.length) {
      body.innerHTML = emptyRow(5, 'No blacklist entries.');
      return;
    }
    body.innerHTML = data.entries
      .map(
        (entry) => `
        <tr>
          <td><span class="pill neutral">${esc(entry.kind)}</span></td>
          <td class="mono" style="word-break:break-all">${esc(entry.value)}</td>
          <td>${esc(entry.reason || '—')}</td>
          <td class="dim">${date(entry.createdAt)}</td>
          <td><button class="btn btn-subtle btn-small" type="button" data-blacklist-remove="${esc(entry.id)}">Remove</button></td>
        </tr>`
      )
      .join('');
  }

  async function addBlacklist(event) {
    event.preventDefault();
    clearError('blacklist-error');
    const kind = $('#blacklist-kind').value;
    const value = $('#blacklist-value').value.trim();
    const reason = $('#blacklist-reason').value.trim();
    const btn = $('#blacklist-submit');
    btn.disabled = true;
    try {
      await adminApi('/api/admin/blacklist', { method: 'POST', body: { kind, value, reason } });
      $('#blacklist-form').reset();
      window.KET.toast('Restriction added.', 'ok');
      await loadBlacklist();
    } catch (err) {
      if (err.status !== 401) showError('blacklist-error', err.message || 'Could not add restriction.');
    } finally {
      btn.disabled = false;
    }
  }

  async function removeBlacklist(id) {
    if (!window.confirm('Remove this restriction?')) return;
    try {
      await adminApi(`/api/admin/blacklist/${encodeURIComponent(id)}`, { method: 'DELETE' });
      window.KET.toast('Restriction removed.', 'ok');
      await loadBlacklist();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Could not remove restriction.', 'error');
    }
  }

  // ── Audit ─────────────────────────────────────────────────────────────

  async function loadAudit() {
    const data = await adminApi('/api/admin/audit?limit=200');
    const body = $('#audit-body');
    if (!data.entries.length) {
      body.innerHTML = emptyRow(5, 'No audit entries yet.');
      return;
    }
    body.innerHTML = data.entries
      .map(
        (entry) => `
        <tr>
          <td class="dim">${date(entry.createdAt, true)}</td>
          <td class="mono">${esc(entry.actor)}</td>
          <td><b>${esc(entry.action)}</b></td>
          <td class="mono">${esc(entry.target || '—')}</td>
          <td class="dim" style="max-width:320px;word-break:break-word">${esc(
            entry.detail ? JSON.stringify(entry.detail) : '—'
          )}</td>
        </tr>`
      )
      .join('');
  }

  // ── Settings ──────────────────────────────────────────────────────────

  async function loadSettings() {
    const data = await adminApi('/api/admin/settings');
    $('#setting-brand').value = data.brand || '';
    $('#setting-support').value = data.supportEmail || '';
    $('#setting-discord').value = data.discordInvite || '';
    $('#setting-ticket').value = data.discordTicketUrl || '';
    $('#setting-manual-enabled').checked = Boolean(data.manualPayments);
    $('#setting-cashapp').value = data.manualCashapp || '';
    $('#setting-paypal').value = data.manualPaypal || '';
    $('#setting-crypto').value = data.manualCrypto || '';
    $('#setting-manual-instructions').value = data.manualInstructions || '';
    $('#setting-webhook').value = '';
    const webhookState = $('#webhook-state');
    webhookState.className = data.webhookConfigured ? 'banner info' : 'banner warn';
    webhookState.textContent = data.webhookConfigured
      ? `Connected · ${data.webhookMasked}`
      : 'No webhook configured. Purchase records will not be delivered to Discord.';
    $('#stripe-state').textContent = data.stripeConfigured ? 'Connected' : 'Not configured';
    const modeLabels = { manual: 'Manual payments', stripe: 'Live Stripe', demo: 'Demo mode', disabled: 'Disabled' };
    $('#payment-state').textContent = modeLabels[data.paymentMode] || '—';
    $('#bot-state').textContent = data.botSecretConfigured ? 'Secret configured' : 'Missing secret';

    const manualBanner = $('#manual-banner');
    const manualReady = Boolean(data.manualCashapp || data.manualPaypal || data.manualCrypto);
    manualBanner.className = data.manualPayments && manualReady ? 'banner info' : 'banner warn';
    manualBanner.textContent = data.manualPayments && manualReady
      ? `Manual checkout is live · ${[data.manualCashapp, data.manualPaypal, data.manualCrypto].filter(Boolean).length} method(s) configured`
      : 'Manual checkout is off. Add Cash App, PayPal, or crypto details and enable it.';

    const stripeBanner = $('#stripe-banner');
    stripeBanner.className = data.stripeConfigured ? 'banner info' : 'banner warn';
    const sourceLabel = data.stripeSource === 'env' ? 'server/.env' : 'admin console';
    stripeBanner.textContent = data.stripeConfigured
      ? `Connected · key from ${sourceLabel}${data.stripeWebhookConfigured ? ' · webhook signing enabled' : ' · webhook secret missing'}`
      : `Stripe is not configured. Checkout uses ${data.demoMode ? 'demo mode' : 'disabled mode'}.`;
    $('#setting-stripe-key').value = '';
    $('#setting-stripe-webhook').value = '';
    $('#setting-stripe-endpoint').value = data.stripeWebhookUrl || '';
  }

  async function saveSettings(event) {
    event.preventDefault();
    clearError('settings-error');
    const btn = $('#settings-submit');
    btn.disabled = true;
    try {
      await adminApi('/api/admin/settings', {
        method: 'PUT',
        body: {
          brand: $('#setting-brand').value.trim(),
          supportEmail: $('#setting-support').value.trim(),
          discordInvite: $('#setting-discord').value.trim(),
        },
      });
      window.KET.toast('Storefront settings saved.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('settings-error', err.message || 'Save failed.');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveManual(event) {
    event.preventDefault();
    clearError('manual-error');
    const btn = $('#manual-submit');
    btn.disabled = true;
    try {
      await adminApi('/api/admin/settings', {
        method: 'PUT',
        body: {
          manualPayments: $('#setting-manual-enabled').checked,
          manualCashapp: $('#setting-cashapp').value.trim(),
          manualPaypal: $('#setting-paypal').value.trim(),
          manualCrypto: $('#setting-crypto').value.trim(),
          manualInstructions: $('#setting-manual-instructions').value.trim(),
          discordTicketUrl: $('#setting-ticket').value.trim(),
        },
      });
      window.KET.toast('Manual payment settings saved.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('manual-error', err.message || 'Could not save manual payments.');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveWebhook(event) {
    event.preventDefault();
    clearError('webhook-error');
    const value = $('#setting-webhook').value.trim();
    if (!value) return showError('webhook-error', 'Enter a webhook URL, or use Remove to disconnect.');
    try {
      await adminApi('/api/admin/settings', { method: 'PUT', body: { webhookUrl: value } });
      $('#setting-webhook').value = '';
      window.KET.toast('Purchase webhook saved.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('webhook-error', err.message || 'Could not save webhook.');
    }
  }

  async function removeWebhook() {
    if (!window.confirm('Remove the Discord purchase webhook?')) return;
    try {
      await adminApi('/api/admin/settings', { method: 'PUT', body: { webhookUrl: '' } });
      window.KET.toast('Webhook removed.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Could not remove webhook.', 'error');
    }
  }

  async function saveStripe(event) {
    event.preventDefault();
    clearError('stripe-error');
    const key = $('#setting-stripe-key').value.trim();
    const webhook = $('#setting-stripe-webhook').value.trim();
    if (!key && !webhook) return showError('stripe-error', 'Enter a secret key or a webhook signing secret.');
    const body = {};
    if (key) body.stripeSecretKey = key;
    if (webhook) body.stripeWebhookSecret = webhook;
    const btn = $('#stripe-form button[type="submit"]');
    btn.disabled = true;
    try {
      await adminApi('/api/admin/settings', { method: 'PUT', body });
      window.KET.toast('Stripe keys saved.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('stripe-error', err.message || 'Could not save Stripe keys.');
    } finally {
      btn.disabled = false;
    }
  }

  async function testStripe() {
    clearError('stripe-error');
    const btn = $('#test-stripe');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      const data = await adminApi('/api/admin/settings/test-stripe', { method: 'POST', body: {} });
      const note =
        data.mode === 'restricted'
          ? ' · restricted key'
          : data.chargesEnabled === false
            ? ' · charges disabled'
            : '';
      window.KET.toast(`Stripe OK · ${data.account}${note}`, data.chargesEnabled === false ? 'error' : 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('stripe-error', err.message || 'Stripe test failed.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  }

  async function removeStripe() {
    if (!window.confirm('Remove the stored Stripe keys? Checkout falls back to demo mode.')) return;
    clearError('stripe-error');
    try {
      await adminApi('/api/admin/settings', { method: 'PUT', body: { clearStripe: true } });
      window.KET.toast('Stripe keys removed.', 'ok');
      await loadSettings();
    } catch (err) {
      if (err.status !== 401) showError('stripe-error', err.message || 'Could not remove Stripe keys.');
    }
  }

  async function testWebhook() {
    const btn = $('#test-webhook');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await adminApi('/api/admin/settings/test-webhook', { method: 'POST', body: {} });
      window.KET.toast('Test message delivered to Discord.', 'ok');
    } catch (err) {
      if (err.status !== 401) window.KET.toast(err.message || 'Webhook test failed.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send test';
    }
  }

  async function revealByCode(code, outputEl, errorEl) {
    clearError(errorEl);
    outputEl.hidden = true;
    const clean = code.trim();
    if (!clean) return showError(errorEl, 'Enter a verification code.');
    try {
      const data = await adminApi('/api/admin/reveal', { method: 'POST', body: { code: clean } });
      outputEl.hidden = false;
      outputEl.textContent = JSON.stringify(data, null, 2);
      window.KET.toast('Record decrypted. Code marked as used.', 'ok');
    } catch (err) {
      if (err.status !== 401) showError(errorEl, err.message || 'Reveal failed.');
    }
  }

  // ── Login / boot ──────────────────────────────────────────────────────

  async function boot() {
    try {
      await window.KET.api('/api/admin/me');
      showShell();
      await loadView('overview');
    } catch {
      showLogin();
    }
  }

  function wire() {
    $('#admin-login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      loginError.classList.remove('show');
      const secret = $('#admin-secret').value;
      const btn = $('#admin-login-submit');
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        await window.KET.api('/api/admin/login', { method: 'POST', body: { secret } });
        $('#admin-secret').value = '';
        showShell();
        await loadView('overview');
        window.KET.toast('Admin console unlocked.', 'ok');
      } catch (err) {
        loginError.textContent = err.message || 'Invalid admin key.';
        loginError.classList.add('show');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Unlock console';
      }
    });

    $$('[data-admin-logout]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await window.KET.api('/api/admin/logout', { method: 'POST', body: {} });
        } catch {
          /* ignore */
        }
        showLogin();
      })
    );

    $$('.admin-nav [data-view]').forEach((btn) =>
      btn.addEventListener('click', () => loadView(btn.dataset.view))
    );

    $('#refresh-btn').addEventListener('click', () => loadView(state.view));
    $('#orders-refresh').addEventListener('click', loadOrders);
    $('#licenses-refresh').addEventListener('click', loadLicenses);
    $('#customers-refresh').addEventListener('click', loadCustomers);
    $('#order-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadOrders();
    });
    $('#license-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadLicenses();
    });
    $('#customer-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadCustomers();
    });

    $('#license-form').addEventListener('submit', generateLicenses);
    $('#product-form').addEventListener('submit', saveProduct);
    $('#new-product').addEventListener('click', () => openProductModal(null));
    $('#blacklist-form').addEventListener('submit', addBlacklist);
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#manual-form').addEventListener('submit', saveManual);
    $('#webhook-form').addEventListener('submit', saveWebhook);
    $('#test-webhook').addEventListener('click', testWebhook);
    $('#remove-webhook').addEventListener('click', removeWebhook);
    $('#stripe-form').addEventListener('submit', saveStripe);
    $('#test-stripe').addEventListener('click', testStripe);
    $('#remove-stripe').addEventListener('click', removeStripe);

    $('#copy-all-keys').addEventListener('click', async () => {
      const text = state.generatedKeys.map((key) => key.key).join('\n');
      const ok = await window.KET.copy(text);
      window.KET.toast(ok ? `${state.generatedKeys.length} keys copied.` : 'Copy failed.', ok ? 'ok' : 'error');
    });

    $('#reveal-code-btn').addEventListener('click', () => {
      $('#reveal-code').value = '';
      $('#reveal-output').hidden = true;
      clearError('reveal-error');
      openModal('reveal-modal');
      setTimeout(() => $('#reveal-code').focus(), 80);
    });
    $('#reveal-submit').addEventListener('click', () =>
      revealByCode($('#reveal-code').value, $('#reveal-output'), $('#reveal-error'))
    );
    $('#settings-reveal').addEventListener('click', () =>
      revealByCode($('#settings-code').value, $('#settings-reveal-out'), 'settings-error')
    );

    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeModals));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeModals();
    });

    document.addEventListener('click', (event) => {
      const target = event.target.closest(
        '[data-order-view],[data-order-refund],[data-order-confirm],[data-order-cancel],[data-order-revoke],[data-license-revoke],[data-license-blacklist],[data-product-edit],[data-user-blacklist],[data-user-unblacklist],[data-blacklist-remove]'
      );
      if (!target) return;
      const ds = target.dataset;
      if (ds.orderView) openOrder(ds.orderView);
      else if (ds.orderRefund) refundOrder(ds.orderRefund);
      else if (ds.orderConfirm) confirmOrder(ds.orderConfirm);
      else if (ds.orderCancel) cancelOrder(ds.orderCancel);
      else if (ds.orderRevoke) revokeOrder(ds.orderRevoke);
      else if (ds.licenseRevoke) revokeLicense(ds.licenseRevoke);
      else if (ds.licenseBlacklist) blacklistLicense(ds.licenseBlacklist);
      else if (ds.productEdit) {
        const product = state.products.find((item) => item.id === ds.productEdit);
        if (product) openProductModal(product);
      } else if (ds.userBlacklist) setUserBlacklist(ds.userBlacklist, true);
      else if (ds.userUnblacklist) setUserBlacklist(ds.userUnblacklist, false);
      else if (ds.blacklistRemove) removeBlacklist(ds.blacklistRemove);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wire();
    boot();
  });
})();
