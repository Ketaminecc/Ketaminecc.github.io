'use strict';

/* Live USD → crypto conversion for manual checkout.
   Coinbase's public spot endpoint needs no key. Rates are cached for a minute
   so one success-page load cannot hammer the upstream API. */

const CACHE_MS = 60_000;
const TIMEOUT_MS = 6_000;

const ASSETS = [
  {
    code: 'BTC',
    name: 'Bitcoin',
    network: 'Bitcoin network',
    decimals: 8,
    rateField: 'btcUsd',
    addressField: 'btc',
  },
  {
    code: 'ETH',
    name: 'Ethereum',
    network: 'Ethereum network',
    decimals: 6,
    rateField: 'ethUsd',
    addressField: 'eth',
  },
  {
    code: 'USDT',
    name: 'Tether',
    network: 'Ethereum (ERC-20)',
    decimals: 2,
    rateField: 'usdtUsd',
    addressField: 'usdt',
  },
];

let cache = null;
let inflight = null;

async function spot(pair) {
  const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Coinbase ${pair} returned ${res.status}`);
  const data = await res.json();
  const value = Number(data?.data?.amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${pair} rate`);
  return value;
}

async function refresh() {
  const [btc, eth, usdt] = await Promise.allSettled([
    spot('BTC-USD'),
    spot('ETH-USD'),
    spot('USDT-USD'),
  ]);
  const next = {
    btcUsd: btc.status === 'fulfilled' ? btc.value : cache?.btcUsd ?? null,
    ethUsd: eth.status === 'fulfilled' ? eth.value : cache?.ethUsd ?? null,
    usdtUsd: usdt.status === 'fulfilled' ? usdt.value : cache?.usdtUsd ?? 1,
    updatedAt: Date.now(),
  };
  if (next.btcUsd === null && next.ethUsd === null) {
    throw new Error('Crypto rates are unavailable.');
  }
  cache = next;
  return cache;
}

async function cryptoRates({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.updatedAt < CACHE_MS) {
    return { ...cache, stale: false };
  }
  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  try {
    return { ...(await inflight), stale: false };
  } catch (err) {
    if (cache) return { ...cache, stale: true };
    throw err;
  }
}

function cryptoAmounts(amountCents, addresses, rates) {
  const dollars = Number(amountCents) / 100;
  const assets = [];
  for (const asset of ASSETS) {
    const address = String(addresses?.[asset.addressField] || '').trim();
    const price = Number(rates?.[asset.rateField]);
    if (!address || !Number.isFinite(price) || price <= 0) continue;

    let amount;
    if (asset.code === 'USDT') {
      /* Tether trades within a few basis points of $1; charge the exact
         displayed amount rounded up to the cent. */
      amount = Math.ceil((dollars / price) * 100) / 100;
    } else {
      const factor = 10 ** asset.decimals;
      amount = Math.ceil((dollars / price) * factor) / factor;
    }

    assets.push({
      code: asset.code,
      name: asset.name,
      network: asset.network,
      address,
      usdPrice: price,
      amount,
      amountText: amount.toFixed(asset.decimals),
      usdValue: Math.round(amount * price * 100) / 100,
    });
  }
  return assets;
}

module.exports = { cryptoRates, cryptoAmounts };
