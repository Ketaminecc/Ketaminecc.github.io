'use strict';

/* The loader page is the readable face of POST /api/loader/info. It renders the
   snapshot exactly as the desktop client receives it, which makes this page the
   live documentation for the contract: if a field is missing here, the client is
   missing it too. */
(function () {
  const form = document.getElementById('lookup-form');
  const keyInput = document.getElementById('license-key');
  const hwidInput = document.getElementById('license-hwid');
  const submit = document.getElementById('lookup-submit');
  const copy = document.getElementById('lookup-copy');
  const note = document.getElementById('lookup-note');
  const stats = document.getElementById('lookup-stats');
  const panel = document.getElementById('lookup-panel');
  const empty = document.getElementById('lookup-empty');
  const json = document.getElementById('lookup-json');
  const source = document.getElementById('lookup-source');

  let last = null;

  function say(message) {
    note.textContent = message || '';
  }

  function value(id, text) {
    document.getElementById(id).textContent = text;
  }

  function render(data) {
    stats.hidden = false;
    panel.hidden = false;
    empty.hidden = true;

    value('stat-status', data.status || '-');
    value('stat-product', data.product || 'Unassigned');
    value('stat-expires', data.lifetime ? 'Lifetime' : data.expiresAt ? window.KET.date(data.expiresAt) : '-');
    value('stat-machine', data.bound ? data.bound.hwidPreview : 'Not bound');
    source.textContent = data.source === 'session' ? 'Session token' : 'License key';

    const readout = Object.assign({}, data);
    if (data.hwidMatch !== null) {
      readout.hwidMatch = data.hwidMatch
        ? 'this machine is the bound machine'
        : 'this machine is NOT the bound machine';
    }
    json.textContent = JSON.stringify(readout, null, 2);
  }

  async function lookup() {
    const key = keyInput.value.trim();
    const hwid = hwidInput.value.trim().toLowerCase();
    if (!key) {
      say('Enter a license key.');
      return;
    }
    submit.disabled = true;
    say('Checking...');
    try {
      const data = await window.KET.api('/api/loader/info', {
        method: 'POST',
        body: { key, hwid },
      });
      last = data;
      render(data);
      say('');
    } catch (err) {
      last = null;
      say(err && err.message ? err.message : 'Lookup failed.');
    } finally {
      submit.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    lookup();
  });

  copy.addEventListener('click', async () => {
    if (!last) {
      say('Nothing to copy yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(last, null, 2));
      say('Copied.');
    } catch {
      say('Clipboard is blocked on this origin.');
    }
  });

  const params = new URLSearchParams(window.location.search);
  const preset = params.get('key');
  if (preset) {
    keyInput.value = preset;
    lookup();
  }
})();
