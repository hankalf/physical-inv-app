/* Physical inventory handheld client.
 *
 * Offline-first: the master list for a session is cached in IndexedDB, so every
 * scan is validated on the device with no network round trip. Counted lines are
 * written locally first and pushed to the server whenever a connection exists.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ IndexedDB
  const DB_NAME = 'invcount';
  const DB_VERSION = 1;
  let idb = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('loc')) d.createObjectStore('loc', { keyPath: 'c' });
        if (!d.objectStoreNames.contains('bc')) d.createObjectStore('bc', { keyPath: 'b' });
        if (!d.objectStoreNames.contains('item')) d.createObjectStore('item', { keyPath: 's' });
        if (!d.objectStoreNames.contains('lines')) {
          const s = d.createObjectStore('lines', { keyPath: 'clientId' });
          s.createIndex('synced', 'synced');
          s.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (store, mode) => idb.transaction(store, mode).objectStore(store);
  const wrap = (req) =>
    new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

  const metaGet = (k) => wrap(tx('meta', 'readonly').get(k));
  const metaSet = (k, v) => wrap(tx('meta', 'readwrite').put(v, k));

  function bulkPut(store, rows, map) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      for (const r of rows) os.put(map(r));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  function clearStores(names) {
    return new Promise((resolve, reject) => {
      const t = idb.transaction(names, 'readwrite');
      for (const n of names) t.objectStore(n).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // ------------------------------------------------------------------ state
  const state = {
    counter: '',
    device: '',
    session: null,       // { id, name, blind, requireLpn, allowOverride }
    steps: [],
    stepIndex: 0,
    draft: {},           // location, sku, barcode, packQty, lpn
    pendingOverride: null,
    qtyConfirm: null,
    syncing: false,
  };

  const LARGE_QTY = Number(localStorage.getItem('largeQtyThreshold') || 1000);

  const $ = (id) => document.getElementById(id);
  const els = {
    hdrTitle: $('hdrTitle'), chipNet: $('chipNet'), chipQueue: $('chipQueue'),
    scrSetup: $('scrSetup'), scrScan: $('scrScan'), scrOverride: $('scrOverride'), scrHistory: $('scrHistory'),
    fCounter: $('fCounter'), fSession: $('fSession'), fDevice: $('fDevice'),
    btnStart: $('btnStart'), btnRefreshSessions: $('btnRefreshSessions'),
    setupMsg: $('setupMsg'), cacheInfo: $('cacheInfo'),
    ctx: $('ctx'), stepLabel: $('stepLabel'), prompt: $('prompt'), fScan: $('fScan'),
    btnKeyboard: $('btnKeyboard'), btnBack: $('btnBack'), scanMsg: $('scanMsg'),
    btnChangeLoc: $('btnChangeLoc'), btnHistory: $('btnHistory'), btnEnd: $('btnEnd'),
    ovCtx: $('ovCtx'), fReason: $('fReason'), fReasonNote: $('fReasonNote'),
    btnOverrideAccept: $('btnOverrideAccept'), btnOverrideCancel: $('btnOverrideCancel'),
    historyList: $('historyList'), btnHistoryBack: $('btnHistoryBack'),
  };

  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const uuid = () =>
    (crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }));

  function showScreen(name) {
    for (const s of [els.scrSetup, els.scrScan, els.scrOverride, els.scrHistory]) s.classList.remove('active');
    ({ setup: els.scrSetup, scan: els.scrScan, override: els.scrOverride, history: els.scrHistory })[name]
      .classList.add('active');
    if (name === 'scan') focusScan();
  }

  // ------------------------------------------------------------------ feedback
  let audio = null;
  function beep(kind) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const now = audio.currentTime;
      const tones = kind === 'ok' ? [[880, 0]] : kind === 'warn' ? [[660, 0], [660, 0.16]] : [[220, 0], [180, 0.18]];
      for (const [freq, at] of tones) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.14);
        osc.connect(gain).connect(audio.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.16);
      }
    } catch { /* audio is a nicety, never a blocker */ }
    try {
      if (navigator.vibrate) navigator.vibrate(kind === 'err' ? [90, 60, 90] : 40);
    } catch { /* ignore */ }
  }

  function feedback(el, kind, text, detail) {
    el.className = 'feedback show ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err');
    el.innerHTML = '';
    el.appendChild(document.createTextNode(text));
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      el.appendChild(d);
    }
    beep(kind);
    document.body.classList.remove('flash-ok', 'flash-err');
    void document.body.offsetWidth;
    document.body.classList.add(kind === 'err' ? 'flash-err' : 'flash-ok');
  }
  const clearFeedback = (el) => { el.className = 'feedback'; el.textContent = ''; };

  // ------------------------------------------------------------------ network
  const online = () => navigator.onLine !== false;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      ...options,
    });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { msg = (await res.json()).error || msg; } catch { /* keep status text */ }
      throw new Error(msg);
    }
    return res.json();
  }

  async function updateChips() {
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    els.chipQueue.hidden = queued === 0;
    els.chipQueue.textContent = queued + ' queued';
    els.chipNet.textContent = online() ? 'online' : 'OFFLINE';
    els.chipNet.className = 'chip ' + (online() ? 'online' : 'offline');
  }

  async function syncQueue() {
    if (state.syncing || !online() || !state.session) return;
    state.syncing = true;
    try {
      const pending = await wrap(tx('lines', 'readonly').index('synced').getAll(0));
      const toSend = pending.filter((l) => l.sessionId === state.session.id && !l.voidedLocal);
      if (toSend.length) {
        for (let i = 0; i < toSend.length; i += 200) {
          const batch = toSend.slice(i, i + 200);
          const result = await api(`/api/sessions/${state.session.id}/counts`, {
            method: 'POST',
            body: JSON.stringify(batch.map((l) => ({
              clientId: l.clientId, location: l.location, sku: l.sku,
              scannedBarcode: l.barcode, lpn: l.lpn, qty: l.qty,
              counter: l.counter, device: l.device, pass: l.pass,
              overrideReason: l.overrideReason, unknownItem: l.unknownItem,
              unknownLocation: l.unknownLocation, scannedAt: l.ts,
            }))),
          });
          const ok = new Set(result.accepted || []);
          const t = idb.transaction('lines', 'readwrite');
          const os = t.objectStore('lines');
          for (const l of batch) if (ok.has(l.clientId)) os.put({ ...l, synced: 1 });
          await new Promise((r) => { t.oncomplete = r; });
        }
      }
      // Voids raised while offline.
      const voids = (await wrap(tx('lines', 'readonly').getAll()))
        .filter((l) => l.voidedLocal && l.synced === 1 && !l.voidSynced);
      for (const l of voids) {
        await api(`/api/sessions/${l.sessionId}/void`, {
          method: 'POST', body: JSON.stringify({ clientId: l.clientId }),
        });
        await wrap(tx('lines', 'readwrite').put({ ...l, voidSynced: true }));
      }
    } catch (err) {
      console.warn('sync deferred:', err.message);
    } finally {
      state.syncing = false;
      updateChips();
    }
  }

  // ------------------------------------------------------------------ setup
  async function loadSessions() {
    els.fSession.innerHTML = '';
    try {
      const sessions = await api('/api/sessions');
      if (!sessions.length) {
        els.fSession.innerHTML = '<option value="">No open sessions on the server</option>';
        return;
      }
      for (const s of sessions) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `#${s.id} — ${s.name}`;
        o.dataset.session = JSON.stringify(s);
        els.fSession.appendChild(o);
      }
      const last = await metaGet('lastSessionId');
      if (last) els.fSession.value = String(last);
    } catch (err) {
      // Offline start-up: fall back to whatever this device already cached.
      const cached = await metaGet('session');
      if (cached) {
        const o = document.createElement('option');
        o.value = cached.id;
        o.textContent = `#${cached.id} — ${cached.name} (cached)`;
        o.dataset.session = JSON.stringify(cached);
        els.fSession.appendChild(o);
        feedback(els.setupMsg, 'warn', 'Server unreachable', 'Using the list cached on this device. Scans will queue until Wi-Fi returns.');
      } else {
        els.fSession.innerHTML = '<option value="">Server unreachable</option>';
        feedback(els.setupMsg, 'err', 'Cannot reach the server', err.message);
      }
    }
  }

  async function describeCache() {
    const cached = await metaGet('session');
    if (!cached) { els.cacheInfo.textContent = 'No list cached on this device yet.'; return; }
    const [locs, bcs] = await Promise.all([
      wrap(tx('loc', 'readonly').count()),
      wrap(tx('bc', 'readonly').count()),
    ]);
    const when = await metaGet('cachedAt');
    els.cacheInfo.textContent =
      `Cached: session #${cached.id}, ${locs.toLocaleString()} locations, ${bcs.toLocaleString()} barcodes` +
      (when ? ` (downloaded ${new Date(when).toLocaleString()})` : '');
  }

  async function downloadMaster(sessionId) {
    const cachedSession = await metaGet('session');
    const haveVersion = await metaGet('masterVersion');
    const sameSession = cachedSession && cachedSession.id === sessionId;
    const q = sameSession && haveVersion != null ? `?have=${haveVersion}` : '';
    const data = await api(`/api/sessions/${sessionId}/master${q}`);
    if (data.unchanged) return { unchanged: true };

    await clearStores(['loc', 'bc', 'item']);
    await bulkPut('loc', data.locations, ([c, zone]) => ({ c, zone }));
    await bulkPut('bc', data.barcodes, ([b, sku, pack]) => ({ b, sku, pack }));
    await bulkPut('item', data.items, ([s, desc, uom]) => ({ s, desc, uom }));
    await metaSet('masterVersion', data.masterVersion);
    await metaSet('cachedAt', Date.now());
    return { locations: data.locations.length, barcodes: data.barcodes.length };
  }

  async function start() {
    clearFeedback(els.setupMsg);
    const counter = norm(els.fCounter.value);
    if (!counter) { feedback(els.setupMsg, 'err', 'Enter or scan your badge first'); return; }

    const opt = els.fSession.selectedOptions[0];
    if (!opt || !opt.value) { feedback(els.setupMsg, 'err', 'Pick a count session'); return; }
    const session = JSON.parse(opt.dataset.session);

    els.btnStart.disabled = true;
    els.btnStart.textContent = 'Downloading list…';
    try {
      if (online()) {
        const r = await downloadMaster(session.id);
        if (!r.unchanged && r.locations === 0) {
          feedback(els.setupMsg, 'warn', 'This session has no master data loaded',
            'A supervisor needs to upload the location/item file before counting.');
        }
      } else {
        const cached = await metaGet('session');
        if (!cached || cached.id !== session.id) {
          feedback(els.setupMsg, 'err', 'Offline and no list cached for this session',
            'Connect to Wi-Fi once to download it.');
          return;
        }
      }
      await metaSet('session', session);
      await metaSet('lastSessionId', session.id);
      await metaSet('counter', counter);
      await metaSet('device', els.fDevice.value.trim());

      state.counter = counter;
      state.device = els.fDevice.value.trim() || 'unknown';
      state.session = session;
      state.steps = ['location', 'item', ...(session.requireLpn ? ['lpn'] : []), 'qty'];
      state.draft = {};
      state.stepIndex = 0;

      els.hdrTitle.textContent = `#${session.id} · ${counter}`;
      showScreen('scan');
      renderStep();
      syncQueue();
    } catch (err) {
      feedback(els.setupMsg, 'err', 'Could not start', err.message);
    } finally {
      els.btnStart.disabled = false;
      els.btnStart.textContent = 'Load list & start counting';
      describeCache();
    }
  }

  // ------------------------------------------------------------------ lookups
  const lookupLocation = (code) => wrap(tx('loc', 'readonly').get(code));
  const lookupBarcode = (code) => wrap(tx('bc', 'readonly').get(code));
  const lookupItem = (sku) => wrap(tx('item', 'readonly').get(sku));

  async function countedHere(location, sku) {
    const all = await wrap(tx('lines', 'readonly').getAll());
    return all
      .filter((l) => l.sessionId === state.session.id && l.location === location && l.sku === sku && !l.voidedLocal)
      .reduce((sum, l) => sum + Number(l.qty), 0);
  }

  // ------------------------------------------------------------------ scan flow
  function renderStep() {
    state.qtyConfirm = null;
    const step = state.steps[state.stepIndex];
    const n = state.stepIndex + 1;
    els.stepLabel.textContent = `Step ${n} of ${state.steps.length}`;
    els.prompt.textContent = {
      location: 'Scan LOCATION',
      item: 'Scan ITEM',
      lpn: 'Scan PALLET / LPN',
      qty: 'Enter QUANTITY',
    }[step];

    els.fScan.value = '';
    if (step === 'qty') {
      els.fScan.inputMode = 'decimal';
      els.fScan.setAttribute('type', 'text');
    } else {
      els.fScan.inputMode = keyboardOn ? 'text' : 'none';
      els.fScan.setAttribute('type', 'text');
    }
    renderContext();
    focusScan();
  }

  function renderContext() {
    const d = state.draft;
    const rows = [];
    rows.push(['Location', d.location || '—']);
    if (d.sku) rows.push(['Item', d.sku]);
    if (d.description) rows.push(['Description', d.description]);
    if (d.packQty > 1) rows.push(['Pack size', `${d.packQty} per scan`]);
    if (d.lpn) rows.push(['LPN', d.lpn]);
    els.ctx.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
      const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
      row.append(ks, vs);
      els.ctx.appendChild(row);
    }
  }

  let keyboardOn = false;
  function focusScan() {
    // Keep the field focused so the wedge always has somewhere to type.
    setTimeout(() => { try { els.fScan.focus(); } catch { /* ignore */ } }, 30);
  }

  async function handleEntry(raw) {
    const value = norm(raw);
    if (!value) return;
    clearFeedback(els.scanMsg);
    const step = state.steps[state.stepIndex];

    if (step === 'location') {
      const hit = await lookupLocation(value);
      if (!hit) return rejectOrOverride('location', value, `Location ${value} is not on the list`);
      state.draft = { location: value, zone: hit.zone || '' };
      advance('ok', `Location ${value}`, hit.zone ? `Zone ${hit.zone}` : '');
      return;
    }

    if (step === 'item') {
      const hit = await lookupBarcode(value);
      if (!hit) return rejectOrOverride('item', value, `Barcode ${value} is not on the list`);
      const item = await lookupItem(hit.sku);
      state.draft.sku = hit.sku;
      state.draft.barcode = value;
      state.draft.packQty = Number(hit.pack) || 1;
      state.draft.description = (item && item.desc) || '';
      const already = await countedHere(state.draft.location, hit.sku);
      advance('ok', state.draft.description || hit.sku,
        already > 0 ? `Already counted here: ${already}. This will add to it.` : `SKU ${hit.sku}`);
      return;
    }

    if (step === 'lpn') {
      state.draft.lpn = value;
      advance('ok', `LPN ${value}`);
      return;
    }

    if (step === 'qty') {
      // Strict: a stray scan into the quantity field must never become a count.
      const cleaned = value.replace(/[\s,]/g, '');
      if (!/^\d+(\.\d+)?$/.test(cleaned)) {
        feedback(els.scanMsg, 'err', `"${value}" is not a quantity`,
          'Type a number. If you meant to scan an item, press Back first.');
        els.fScan.value = '';
        focusScan();
        return;
      }
      const qty = Number(cleaned);
      // Fat-finger guard: a big number has to be entered twice.
      if (qty >= LARGE_QTY && state.qtyConfirm !== qty) {
        state.qtyConfirm = qty;
        feedback(els.scanMsg, 'warn', `Confirm quantity ${qty}`,
          'That is unusually large. Enter it again to accept, or type the correct number.');
        els.fScan.value = '';
        focusScan();
        return;
      }
      state.qtyConfirm = null;
      await commitLine(qty);
      return;
    }
  }

  function advance(kind, text, detail) {
    feedback(els.scanMsg, kind, text, detail);
    state.stepIndex++;
    renderStep();
  }

  function rejectOrOverride(what, value, message) {
    if (!state.session.allowOverride) {
      feedback(els.scanMsg, 'err', message, 'Rescan, or ask a supervisor.');
      els.fScan.value = '';
      focusScan();
      return;
    }
    state.pendingOverride = { what, value };
    beep('err');
    els.ovCtx.innerHTML = '';
    const row = document.createElement('div');
    const k = document.createElement('span'); k.className = 'k';
    k.textContent = what === 'location' ? 'Scanned location' : 'Scanned barcode';
    const v = document.createElement('span'); v.className = 'v'; v.textContent = value;
    row.append(k, v);
    els.ovCtx.appendChild(row);
    els.fReason.value = '';
    els.fReasonNote.value = '';
    showScreen('override');
  }

  function acceptOverride() {
    const reason = els.fReason.value;
    if (!reason) { feedback(els.scanMsg, 'err', 'Pick a reason'); return; }
    const note = els.fReasonNote.value.trim();
    const full = note ? `${reason}: ${note}` : reason;
    const { what, value } = state.pendingOverride;

    if (what === 'location') {
      state.draft = { location: value, unknownLocation: true, overrideReason: full };
    } else {
      state.draft.sku = value;
      state.draft.barcode = value;
      state.draft.packQty = 1;
      state.draft.description = '(not in master file)';
      state.draft.unknownItem = true;
      state.draft.overrideReason = full;
    }
    state.pendingOverride = null;
    state.stepIndex++;
    showScreen('scan');
    renderStep();
    feedback(els.scanMsg, 'warn', 'Accepted with override', full);
  }

  async function commitLine(qty) {
    const d = state.draft;
    const pack = Number(d.packQty) || 1;
    const total = qty * pack;
    const line = {
      clientId: uuid(),
      sessionId: state.session.id,
      location: d.location,
      sku: d.sku,
      barcode: d.barcode || null,
      lpn: d.lpn || null,
      qty: total,
      counter: state.counter,
      device: state.device,
      pass: 1,
      overrideReason: d.overrideReason || null,
      unknownItem: d.unknownItem ? 1 : 0,
      unknownLocation: d.unknownLocation ? 1 : 0,
      ts: new Date().toISOString(),
      synced: 0,
      voidedLocal: false,
    };
    await wrap(tx('lines', 'readwrite').put(line));
    updateChips();
    syncQueue();

    const detail = pack > 1
      ? `${qty} × ${pack} = ${total} ${d.description || d.sku}`
      : `${total} × ${d.description || d.sku}`;
    // Location stays put; the next scan is the next item in the same bin.
    state.draft = { location: d.location, zone: d.zone };
    state.stepIndex = 1;
    renderStep();
    feedback(els.scanMsg, 'ok', 'Counted', `${detail} @ ${d.location}`);
  }

  function stepBack() {
    if (state.stepIndex === 0) return;
    state.stepIndex--;
    const step = state.steps[state.stepIndex];
    if (step === 'location') state.draft = {};
    if (step === 'item') {
      delete state.draft.sku; delete state.draft.barcode;
      delete state.draft.description; delete state.draft.packQty;
      delete state.draft.unknownItem;
    }
    if (step === 'lpn') delete state.draft.lpn;
    clearFeedback(els.scanMsg);
    renderStep();
  }

  // ------------------------------------------------------------------ history
  async function renderHistory() {
    const all = await wrap(tx('lines', 'readonly').getAll());
    const mine = all
      .filter((l) => l.sessionId === state.session.id)
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, 50);
    els.historyList.innerHTML = '';
    if (!mine.length) {
      els.historyList.innerHTML = '<div class="muted">Nothing counted on this device yet.</div>';
      return;
    }
    for (const l of mine) {
      const div = document.createElement('div');
      div.className = 'item' + (l.voidedLocal ? ' voided' : '');
      const top = document.createElement('div');
      top.className = 'top';
      const left = document.createElement('span');
      left.textContent = `${l.location} · ${l.sku}`;
      const right = document.createElement('span');
      right.textContent = l.qty;
      top.append(left, right);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${new Date(l.ts).toLocaleTimeString()} · ${l.synced ? 'synced' : 'queued'}` +
        (l.overrideReason ? ` · override: ${l.overrideReason}` : '');
      div.append(top, sub);
      if (!l.voidedLocal) {
        const btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = 'Void this line';
        btn.onclick = async () => {
          await wrap(tx('lines', 'readwrite').put({ ...l, voidedLocal: true }));
          if (l.synced && online()) {
            try {
              await api(`/api/sessions/${l.sessionId}/void`, {
                method: 'POST', body: JSON.stringify({ clientId: l.clientId }),
              });
              await wrap(tx('lines', 'readwrite').put({ ...l, voidedLocal: true, voidSynced: true }));
            } catch { /* the sync loop retries it */ }
          }
          beep('warn');
          renderHistory();
          updateChips();
        };
        div.appendChild(btn);
      }
      els.historyList.appendChild(div);
    }
  }

  // ------------------------------------------------------------------ wiring
  els.btnStart.onclick = start;
  els.btnRefreshSessions.onclick = loadSessions;
  els.btnBack.onclick = stepBack;
  els.btnChangeLoc.onclick = () => {
    state.draft = {};
    state.stepIndex = 0;
    clearFeedback(els.scanMsg);
    renderStep();
  };
  els.btnHistory.onclick = () => { renderHistory(); showScreen('history'); };
  els.btnHistoryBack.onclick = () => { showScreen('scan'); renderStep(); };
  els.btnOverrideAccept.onclick = acceptOverride;
  els.btnOverrideCancel.onclick = () => {
    state.pendingOverride = null;
    showScreen('scan');
    renderStep();
  };
  els.btnEnd.onclick = async () => {
    await syncQueue();
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    if (queued > 0 && !confirm(`${queued} line(s) have not reached the server yet. Leave anyway?`)) return;
    showScreen('setup');
    describeCache();
  };
  els.btnKeyboard.onclick = () => {
    keyboardOn = !keyboardOn;
    els.btnKeyboard.textContent = keyboardOn ? 'Keyboard on' : 'Keyboard';
    els.fScan.inputMode = keyboardOn ? 'text' : 'none';
    els.fScan.blur();
    focusScan();
  };

  els.fScan.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = els.fScan.value;
      els.fScan.value = '';
      handleEntry(v);
    }
  });
  // Tapping anywhere returns focus to the scan field.
  els.scrScan.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') focusScan();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && els.scrScan.classList.contains('active')) focusScan();
  });

  window.addEventListener('online', () => { updateChips(); syncQueue(); });
  window.addEventListener('offline', updateChips);
  setInterval(() => { updateChips(); syncQueue(); }, 20000);

  // ------------------------------------------------------------------ boot
  (async () => {
    idb = await openDb();
    els.fCounter.value = (await metaGet('counter')) || '';
    els.fDevice.value = (await metaGet('device')) || '';
    await loadSessions();
    await describeCache();
    await updateChips();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* http-only hosts */ });
    }
  })();
})();
