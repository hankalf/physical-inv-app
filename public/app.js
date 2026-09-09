/* Physical inventory handheld client - pallet counting.
 *
 * Prompts, one per screen:  PALLET ID -> QTY -> BIN -> COMMENTS (optional)
 *
 * Offline-first: the session's bin list and pallet list are cached in IndexedDB
 * at sign-on, so every scan is validated on the device with no network round
 * trip. Count lines are written locally first and pushed to the server whenever
 * a connection exists; each carries a device-generated id so a retry can never
 * double-count.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------ IndexedDB */
  const DB_NAME = 'invcount';
  const DB_VERSION = 2;
  let idb = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        // v1 stores from the SKU-based prototype are dropped outright.
        for (const old of ['bc', 'item', 'lines', 'loc']) if (d.objectStoreNames.contains(old)) d.deleteObjectStore(old);
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        d.createObjectStore('loc', { keyPath: 'c' });
        d.createObjectStore('pal', { keyPath: 'p' });
        if (!d.objectStoreNames.contains('dup')) d.createObjectStore('dup', { keyPath: 'p' });
        const s = d.createObjectStore('lines', { keyPath: 'clientId' });
        s.createIndex('synced', 'synced');
        s.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (store, mode) => idb.transaction(store, mode).objectStore(store);
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
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

  /* ------------------------------------------------------------ state */
  const LARGE_QTY = Number(localStorage.getItem('largeQtyThreshold') || 1000);
  const QUICK_COMMENTS = ['Damaged', 'Partial pallet', 'Mixed pallet', 'Label unreadable', 'Needs recount', 'Blocked / could not reach'];

  const state = {
    deviceId: '',
    team: '',
    employees: [],
    session: null,     // { id, name, palletMode, guided, askComments, masterVersion }
    assignment: null,  // team-status payload from the server
    steps: [],
    stepIndex: 0,
    draft: {},
    override: null,    // { title, why, rows, apply(reasonText) }
    qtyConfirm: null,
    syncing: false,
    keyboardOn: false,
  };

  const $ = (id) => document.getElementById(id);
  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }));

  const SCREENS = ['scrDevice', 'scrSignon', 'scrAssign', 'scrScan', 'scrOverride', 'scrHistory'];
  function showScreen(name) {
    for (const s of SCREENS) $(s).classList.toggle('active', s === name);
    if (name === 'scrScan') focusScan();
  }

  /* ------------------------------------------------------------ feedback */
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
    try { if (navigator.vibrate) navigator.vibrate(kind === 'err' ? [90, 60, 90] : 40); } catch { /* ignore */ }
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

  function kv(container, rows) {
    container.innerHTML = '';
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
      const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
      row.append(ks, vs);
      container.appendChild(row);
    }
  }

  /* ------------------------------------------------------------ network */
  const online = () => navigator.onLine !== false;

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'content-type': 'application/json' }, cache: 'no-store', ...options });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { msg = (await res.json()).error || msg; } catch { /* keep status text */ }
      throw new Error(msg);
    }
    return res.json();
  }

  async function updateChips() {
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    $('chipQueue').hidden = queued === 0;
    $('chipQueue').textContent = queued + ' queued';
    $('chipNet').textContent = online() ? 'online' : 'OFFLINE';
    $('chipNet').className = 'chip ' + (online() ? 'online' : 'offline');
    $('chipDevice').hidden = !state.deviceId;
    $('chipDevice').textContent = state.deviceId + (state.team ? ' · T' + state.team : '');
  }

  async function syncQueue() {
    if (state.syncing || !online() || !state.session) return;
    state.syncing = true;
    try {
      const pending = await wrap(tx('lines', 'readonly').index('synced').getAll(0));
      const toSend = pending.filter((l) => l.sessionId === state.session.id && !l.voidedLocal);
      for (let i = 0; i < toSend.length; i += 200) {
        const batch = toSend.slice(i, i + 200);
        const result = await api(`/api/sessions/${state.session.id}/counts`, {
          method: 'POST',
          body: JSON.stringify(batch.map((l) => ({
            clientId: l.clientId, palletId: l.palletId, qty: l.qty, location: l.location,
            comments: l.comments, sku: l.sku, team: l.team, employees: l.employees,
            deviceId: l.deviceId, aisle: l.aisle, unknownPallet: l.unknownPallet,
            unknownLocation: l.unknownLocation, offAssignment: l.offAssignment,
            duplicatePallet: l.duplicatePallet, overrideReason: l.overrideReason, scannedAt: l.ts,
          }))),
        });
        const ok = new Set(result.accepted || []);
        const t = idb.transaction('lines', 'readwrite');
        const os = t.objectStore('lines');
        for (const l of batch) if (ok.has(l.clientId)) os.put({ ...l, synced: 1 });
        await new Promise((r) => { t.oncomplete = r; });
      }
      const voids = (await wrap(tx('lines', 'readonly').getAll()))
        .filter((l) => l.voidedLocal && l.synced === 1 && !l.voidSynced);
      for (const l of voids) {
        await api(`/api/sessions/${l.sessionId}/void`, { method: 'POST', body: JSON.stringify({ clientId: l.clientId }) });
        await wrap(tx('lines', 'readwrite').put({ ...l, voidSynced: true }));
      }
      await pullCountedPallets();
    } catch (err) {
      console.warn('sync deferred:', err.message);
    } finally {
      state.syncing = false;
      updateChips();
    }
  }

  // Pallets other scanners have counted, so a duplicate is caught across devices.
  async function pullCountedPallets() {
    const since = (await metaGet('dupWatermark')) || '';
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    const data = await api(`/api/sessions/${state.session.id}/counted-pallets${q}`);
    if (data.pallets.length) await bulkPut('dup', data.pallets, ([p, loc, team]) => ({ p, loc, team }));
    if (data.watermark) await metaSet('dupWatermark', data.watermark);
  }

  /* ------------------------------------------------------------ device setup */
  async function saveDevice() {
    const id = norm($('fDeviceId').value);
    if (!id) { feedback($('deviceMsg'), 'err', 'Enter a scanner ID'); return; }
    await metaSet('deviceId', id);
    state.deviceId = id;
    updateChips();
    showScreen('scrSignon');
  }

  /* ------------------------------------------------------------ sign-on */
  async function loadSessions() {
    const sel = $('fSession');
    sel.innerHTML = '';
    try {
      const sessions = await api('/api/sessions');
      if (!sessions.length) { sel.innerHTML = '<option value="">No open sessions on the server</option>'; return; }
      for (const s of sessions) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `#${s.id} — ${s.name}`;
        o.dataset.session = JSON.stringify(s);
        sel.appendChild(o);
      }
      const last = await metaGet('lastSessionId');
      if (last) sel.value = String(last);
    } catch (err) {
      const cached = await metaGet('session');
      if (cached) {
        const o = document.createElement('option');
        o.value = cached.id;
        o.textContent = `#${cached.id} — ${cached.name} (cached)`;
        o.dataset.session = JSON.stringify(cached);
        sel.appendChild(o);
        feedback($('signonMsg'), 'warn', 'Server unreachable', 'Using the list cached on this scanner. Counts will queue until Wi-Fi returns.');
      } else {
        sel.innerHTML = '<option value="">Server unreachable</option>';
        feedback($('signonMsg'), 'err', 'Cannot reach the server', err.message);
      }
    }
  }

  function renderEmployees() {
    const box = $('employeeChips');
    box.innerHTML = '';
    for (const e of state.employees) {
      const b = document.createElement('button');
      b.className = 'chip-btn remove';
      b.textContent = e;
      b.onclick = () => { state.employees = state.employees.filter((x) => x !== e); renderEmployees(); };
      box.appendChild(b);
    }
  }
  function addEmployee() {
    const v = norm($('fEmployee').value);
    $('fEmployee').value = '';
    if (!v) return;
    if (!state.employees.includes(v)) state.employees.push(v);
    renderEmployees();
    beep('ok');
    $('fEmployee').focus();
  }

  async function describeCache() {
    const cached = await metaGet('session');
    if (!cached) { $('cacheInfo').textContent = 'No list cached on this scanner yet.'; return; }
    const [locs, pals] = await Promise.all([wrap(tx('loc', 'readonly').count()), wrap(tx('pal', 'readonly').count())]);
    const when = await metaGet('cachedAt');
    $('cacheInfo').textContent =
      `Cached: session #${cached.id}, ${locs.toLocaleString()} bins, ${pals.toLocaleString()} pallets` +
      (when ? ` (downloaded ${new Date(when).toLocaleString()})` : '');
  }

  async function downloadMaster(session) {
    const cachedSession = await metaGet('session');
    const haveVersion = await metaGet('masterVersion');
    const same = cachedSession && cachedSession.id === session.id;
    const q = same && haveVersion != null ? `?have=${haveVersion}` : '';
    const data = await api(`/api/sessions/${session.id}/master${q}`);
    if (data.unchanged) return { unchanged: true, session: data };
    await clearStores(['loc', 'pal', 'dup']);
    await metaSet('dupWatermark', '');
    await bulkPut('loc', data.locations, ([c, zone, aisle]) => ({ c, zone, aisle }));
    await bulkPut('pal', data.pallets, ([p, sku, desc, expLoc]) => ({ p, sku, desc, expLoc }));
    await metaSet('masterVersion', data.masterVersion);
    await metaSet('cachedAt', Date.now());
    return { bins: data.locations.length, pallets: data.pallets.length, session: data };
  }

  async function signon() {
    clearFeedback($('signonMsg'));
    const team = norm($('fTeam').value);
    if (!team) { feedback($('signonMsg'), 'err', 'Enter your team number'); return; }
    if (norm($('fEmployee').value)) addEmployee();
    if (!state.employees.length) { feedback($('signonMsg'), 'err', 'Add at least one employee ID'); return; }
    const opt = $('fSession').selectedOptions[0];
    if (!opt || !opt.value) { feedback($('signonMsg'), 'err', 'Pick a count session'); return; }
    let session = JSON.parse(opt.dataset.session);

    $('btnStart').disabled = true;
    $('btnStart').textContent = 'Downloading list…';
    try {
      if (online()) {
        const r = await downloadMaster(session);
        session = { ...session, ...r.session, id: session.id, name: session.name };
        if (!r.unchanged && r.bins === 0) {
          feedback($('signonMsg'), 'warn', 'This session has no bin list yet', 'A supervisor needs to upload it before counting.');
        }
      } else {
        const cached = await metaGet('session');
        if (!cached || cached.id !== session.id) {
          feedback($('signonMsg'), 'err', 'Offline and no list cached for this session', 'Connect to Wi-Fi once to download it.');
          return;
        }
        session = cached;
      }
      await metaSet('session', session);
      await metaSet('lastSessionId', session.id);
      await metaSet('team', team);
      await metaSet('employees', state.employees);

      state.team = team;
      state.session = session;
      state.steps = ['pallet', 'qty', 'bin', ...(session.askComments ? ['comments'] : [])];
      state.draft = {};
      state.stepIndex = 0;
      $('hdrTitle').textContent = `#${session.id} · ${session.name}`;
      $('btnToAssign').hidden = !session.guided;
      updateChips();

      if (online()) {
        try {
          state.assignment = await api(`/api/sessions/${session.id}/signon`, {
            method: 'POST',
            body: JSON.stringify({ deviceId: state.deviceId, team, employees: state.employees }),
          });
          await metaSet('assignment', state.assignment);
        } catch (err) {
          feedback($('signonMsg'), 'warn', 'Signed on locally only', err.message);
        }
      } else {
        state.assignment = (await metaGet('assignment')) || null;
      }

      if (session.guided) { renderAssignment(); showScreen('scrAssign'); }
      else { showScreen('scrScan'); renderStep(); }
      syncQueue();
    } catch (err) {
      feedback($('signonMsg'), 'err', 'Could not sign on', err.message);
    } finally {
      $('btnStart').disabled = false;
      $('btnStart').textContent = 'Sign on & load list';
      describeCache();
    }
  }

  /* ------------------------------------------------------------ assignment */
  async function refreshAssignment(silent) {
    if (!state.session || !online()) return;
    try {
      state.assignment = await api(`/api/sessions/${state.session.id}/team-status?team=${encodeURIComponent(state.team)}`);
      await metaSet('assignment', state.assignment);
      renderAssignment();
    } catch (err) {
      if (!silent) feedback($('assignMsg'), 'warn', 'Could not refresh', err.message);
    }
  }

  async function localCountedBins(aisle) {
    const all = await wrap(tx('lines', 'readonly').getAll());
    return new Set(all.filter((l) => l.sessionId === state.session.id && !l.voidedLocal && l.aisle === aisle).map((l) => l.location));
  }

  async function renderAssignment() {
    const a = state.assignment;
    const card = $('assignCard');
    clearFeedback($('assignMsg'));
    $('btnAisleDone').hidden = !(a && a.active);

    if (!a) {
      card.innerHTML = '<div class="assign waiting"><div class="aisle">No plan</div><div class="sub">No assignment loaded for this team. Refresh once Wi-Fi is back, or count freely.</div></div>';
      $('btnCount').textContent = 'Count without an assignment';
      return;
    }
    if (a.active) {
      const counted = new Set([...(a.progress?.countedBins || []), ...(await localCountedBins(a.active.aisle))]);
      const total = a.bins.length;
      card.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'assign';
      box.innerHTML = `<div class="sub">Team ${a.team} — your aisle</div><div class="aisle"></div><div class="sub bins-sub"></div><div class="bins"></div>`;
      box.querySelector('.aisle').textContent = a.active.aisle;
      box.querySelector('.bins-sub').textContent = `${counted.size} of ${total} bins have a count` +
        (a.queued.length ? ` · next: ${a.queued.join(', ')}` : ' · last aisle in your plan');
      const grid = box.querySelector('.bins');
      for (const b of a.bins) {
        const s = document.createElement('span');
        s.textContent = b;
        if (counted.has(b)) s.className = 'counted';
        grid.appendChild(s);
      }
      card.appendChild(box);
      $('btnCount').textContent = `Count aisle ${a.active.aisle}`;
      return;
    }
    if (a.waitingOn) {
      const w = a.waitingOn;
      card.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'assign waiting';
      box.innerHTML = `<div class="sub">Team ${a.team} — next aisle</div><div class="aisle"></div><div class="sub why"></div>`;
      box.querySelector('.aisle').textContent = w.aisle;
      box.querySelector('.why').textContent = w.blockedByTeam
        ? `Waiting: team ${w.blockedByTeam} is still in aisle ${w.blockedByAisle}, which shares racking with ${w.aisle}. Refresh when they finish.`
        : 'Waiting for a supervisor to release this aisle.';
      card.appendChild(box);
      $('btnCount').textContent = 'Count anyway (flagged)';
      return;
    }
    card.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'assign done';
    box.innerHTML = `<div class="sub">Team ${a.team}</div><div class="aisle">All done</div><div class="sub"></div>`;
    box.querySelector('.sub:last-child').textContent = a.done.length
      ? `Finished: ${a.done.join(', ')}. Check with a supervisor for more.`
      : 'No aisles assigned to this team yet. Check with a supervisor.';
    card.appendChild(box);
    $('btnCount').textContent = 'Count without an assignment';
  }

  async function completeAisle() {
    const a = state.assignment;
    if (!a || !a.active) return;
    await syncQueue();
    const counted = new Set([...(a.progress?.countedBins || []), ...(await localCountedBins(a.active.aisle))]);
    const left = a.bins.filter((b) => !counted.has(b)).length;
    if (left > 0 && !confirm(`${left} bin(s) in ${a.active.aisle} have no count. Empty bins are fine — complete the aisle anyway?`)) return;
    if (!online()) { feedback($('assignMsg'), 'err', 'Need Wi-Fi to complete an aisle', 'The next aisle is released by the server.'); return; }
    try {
      state.assignment = await api(`/api/sessions/${state.session.id}/assignments/${a.active.id}/complete`, {
        method: 'POST', body: JSON.stringify({ team: state.team }),
      });
      await metaSet('assignment', state.assignment);
      beep('ok');
      renderAssignment();
    } catch (err) {
      feedback($('assignMsg'), 'err', 'Could not complete aisle', err.message);
    }
  }

  /* ------------------------------------------------------------ lookups */
  const lookupLocation = (code) => wrap(tx('loc', 'readonly').get(code));
  const lookupPallet = (id) => wrap(tx('pal', 'readonly').get(id));
  const lookupDup = (id) => wrap(tx('dup', 'readonly').get(id));

  async function alreadyCounted(palletId) {
    const all = await wrap(tx('lines', 'readonly').getAll());
    const mine = all.find((l) => l.sessionId === state.session.id && !l.voidedLocal && l.palletId === palletId);
    if (mine) return { loc: mine.location, team: mine.team, here: true };
    const other = await lookupDup(palletId);
    return other ? { loc: other.loc, team: other.team, here: false } : null;
  }

  /* ------------------------------------------------------------ scan flow */
  function focusScan() {
    setTimeout(() => { try { $('fScan').focus(); } catch { /* ignore */ } }, 30);
  }

  function renderStep() {
    state.qtyConfirm = null;
    const step = state.steps[state.stepIndex];
    $('stepLabel').textContent = `Step ${state.stepIndex + 1} of ${state.steps.length}`;
    $('prompt').textContent = { pallet: 'Scan PALLET ID', qty: 'Enter QUANTITY', bin: 'Scan BIN LOCATION', comments: 'Comments (optional)' }[step];
    const f = $('fScan');
    f.value = '';
    f.placeholder = step === 'comments' ? 'Type a note or tap one below' : '';
    f.inputMode = step === 'qty' ? 'decimal' : step === 'comments' ? 'text' : (state.keyboardOn ? 'text' : 'none');
    $('btnSkip').hidden = step !== 'comments';
    $('commentChips').hidden = step !== 'comments';
    if (step === 'comments' && !$('commentChips').childElementCount) {
      for (const c of QUICK_COMMENTS) {
        const b = document.createElement('button');
        b.className = 'chip-btn';
        b.textContent = c;
        b.onclick = () => { f.value = f.value ? f.value + '; ' + c : c; focusScan(); };
        $('commentChips').appendChild(b);
      }
    }
    renderContext();
    focusScan();
  }

  function renderContext() {
    const d = state.draft;
    const rows = [];
    if (state.session?.guided && state.assignment?.active) rows.push(['Your aisle', state.assignment.active.aisle]);
    if (d.palletId) rows.push(['Pallet', d.palletId]);
    if (d.description || d.sku) rows.push(['Contents', [d.sku, d.description].filter(Boolean).join(' — ')]);
    if (d.qty != null) rows.push(['Qty', String(d.qty)]);
    if (d.location) rows.push(['Bin', d.location]);
    kv($('ctx'), rows);
  }

  async function handleEntry(raw) {
    const value = norm(raw);
    const step = state.steps[state.stepIndex];
    if (!value && step !== 'comments') return;
    clearFeedback($('scanMsg'));

    if (step === 'pallet') {
      const dup = await alreadyCounted(value);
      const pal = await lookupPallet(value);
      const mode = state.session.palletMode || 'warn';

      const applyPallet = () => {
        state.draft.palletId = value;
        state.draft.sku = pal ? pal.sku : '';
        state.draft.description = pal ? pal.desc : '';
        state.draft.expectedLocation = pal ? pal.expLoc : '';
        if (!pal) state.draft.unknownPallet = 1;
      };

      if (dup) {
        return askOverride({
          title: 'Pallet already counted',
          why: `${value} was already counted in bin ${dup.loc}${dup.here ? ' on this scanner' : ` by team ${dup.team}`}.`,
          rows: [['Pallet', value], ['Counted in', dup.loc], ['By team', dup.team]],
          apply: (reason) => { applyPallet(); state.draft.duplicatePallet = 1; addReason(reason); },
          feedbackText: 'Duplicate accepted',
        });
      }
      if (!pal && mode === 'strict') {
        feedback($('scanMsg'), 'err', `${value} is not on the pallet list`, 'Rescan, or ask a supervisor.');
        return;
      }
      if (!pal && mode === 'warn') {
        return askOverride({
          title: 'Pallet not on the list',
          why: `${value} is not in the uploaded pallet file.`,
          rows: [['Scanned', value]],
          apply: (reason) => { applyPallet(); addReason(reason); },
          feedbackText: 'Unknown pallet accepted',
        });
      }
      applyPallet();
      advance('ok', pal ? (pal.desc || pal.sku || value) : `Pallet ${value}`, pal ? `Pallet ${value}${pal.sku ? ' · ' + pal.sku : ''}` : 'Not in the pallet list');
      return;
    }

    if (step === 'qty') {
      // Strict: a stray scan into the quantity field must never become a count.
      const cleaned = value.replace(/[\s,]/g, '');
      if (!/^\d+(\.\d+)?$/.test(cleaned)) {
        feedback($('scanMsg'), 'err', `"${value}" is not a quantity`, 'Type a number. If you meant to scan something, press Back first.');
        $('fScan').value = '';
        focusScan();
        return;
      }
      const qty = Number(cleaned);
      // Fat-finger guard: a big number has to be entered twice.
      if (qty >= LARGE_QTY && state.qtyConfirm !== qty) {
        state.qtyConfirm = qty;
        feedback($('scanMsg'), 'warn', `Confirm quantity ${qty}`, 'That is unusually large. Enter it again to accept, or type the correct number.');
        $('fScan').value = '';
        focusScan();
        return;
      }
      state.qtyConfirm = null;
      state.draft.qty = qty;
      advance('ok', `Qty ${qty}`);
      return;
    }

    if (step === 'bin') {
      const loc = await lookupLocation(value);
      const active = state.session.guided ? state.assignment?.active?.aisle : null;
      const applyBin = () => {
        state.draft.location = value;
        state.draft.aisle = loc ? loc.aisle : active || '';
        if (!loc) state.draft.unknownLocation = 1;
      };
      if (!loc) {
        return askOverride({
          title: 'Bin not on the list',
          why: `${value} is not in the uploaded bin list.`,
          rows: [['Scanned', value]],
          apply: (reason) => { applyBin(); addReason(reason); },
          feedbackText: 'Unknown bin accepted',
        });
      }
      if (state.session.guided && loc.aisle !== active) {
        return askOverride({
          title: 'Not your aisle',
          why: active
            ? `Bin ${value} is in aisle ${loc.aisle}. Your team is assigned to aisle ${active}.`
            : `Bin ${value} is in aisle ${loc.aisle}, but your team has no active aisle right now.`,
          rows: [['Bin', value], ['Its aisle', loc.aisle], ['Your aisle', active || '—']],
          apply: (reason) => { applyBin(); state.draft.offAssignment = 1; addReason(reason); },
          feedbackText: 'Off-aisle bin accepted',
        });
      }
      applyBin();
      const detail = state.draft.expectedLocation && state.draft.expectedLocation !== value
        ? `System expected this pallet in ${state.draft.expectedLocation}` : (loc.zone ? `Zone ${loc.zone}` : '');
      advance(detail.startsWith('System') ? 'warn' : 'ok', `Bin ${value}`, detail);
      if (state.stepIndex >= state.steps.length) await commitLine();
      return;
    }

    if (step === 'comments') {
      state.draft.comments = $('fScan').value.trim() || null;
      await commitLine();
    }
  }

  function addReason(reason) {
    state.draft.overrideReason = state.draft.overrideReason ? `${state.draft.overrideReason} | ${reason}` : reason;
  }

  function advance(kind, text, detail) {
    feedback($('scanMsg'), kind, text, detail);
    state.stepIndex++;
    if (state.stepIndex < state.steps.length) renderStep();
  }

  function askOverride(spec) {
    if (state.session && state.session.palletMode === 'strict' && spec.title !== 'Not your aisle') {
      feedback($('scanMsg'), 'err', spec.title, spec.why + ' Overrides are off for this session.');
      $('fScan').value = '';
      focusScan();
      return;
    }
    state.override = spec;
    beep('err');
    $('ovTitle').textContent = spec.title;
    $('ovWhy').textContent = spec.why;
    kv($('ovCtx'), spec.rows);
    $('fReason').value = '';
    $('fReasonNote').value = '';
    showScreen('scrOverride');
  }

  async function acceptOverride() {
    const reason = $('fReason').value;
    if (!reason) { beep('err'); $('fReason').focus(); return; }
    const note = $('fReasonNote').value.trim();
    const full = note ? `${reason}: ${note}` : reason;
    const spec = state.override;
    state.override = null;
    spec.apply(full);
    state.stepIndex++;
    showScreen('scrScan');
    if (state.stepIndex < state.steps.length) {
      renderStep();
      feedback($('scanMsg'), 'warn', spec.feedbackText, full);
    } else {
      await commitLine();
    }
  }

  async function commitLine() {
    const d = state.draft;
    const line = {
      clientId: uuid(),
      sessionId: state.session.id,
      palletId: d.palletId,
      qty: d.qty,
      location: d.location,
      comments: d.comments || null,
      sku: d.sku || null,
      team: state.team,
      employees: state.employees,
      deviceId: state.deviceId,
      aisle: d.aisle || null,
      unknownPallet: d.unknownPallet ? 1 : 0,
      unknownLocation: d.unknownLocation ? 1 : 0,
      offAssignment: d.offAssignment ? 1 : 0,
      duplicatePallet: d.duplicatePallet ? 1 : 0,
      overrideReason: d.overrideReason || null,
      ts: new Date().toISOString(),
      synced: 0,
      voidedLocal: false,
    };
    await wrap(tx('lines', 'readwrite').put(line));
    await wrap(tx('dup', 'readwrite').put({ p: line.palletId, loc: line.location, team: line.team }));
    updateChips();
    syncQueue();

    state.draft = {};
    state.stepIndex = 0;
    renderStep();
    feedback($('scanMsg'), 'ok', `Counted ${line.palletId}`,
      `${line.qty}${d.description ? ' × ' + d.description : ''} @ ${line.location}${line.overrideReason ? ' · flagged' : ''}`);
  }

  function stepBack() {
    if (state.stepIndex === 0) return;
    state.stepIndex--;
    const step = state.steps[state.stepIndex];
    if (step === 'pallet') state.draft = {};
    if (step === 'qty') delete state.draft.qty;
    if (step === 'bin') { delete state.draft.location; delete state.draft.aisle; delete state.draft.unknownLocation; delete state.draft.offAssignment; }
    clearFeedback($('scanMsg'));
    renderStep();
  }

  /* ------------------------------------------------------------ history */
  async function renderHistory() {
    const all = await wrap(tx('lines', 'readonly').getAll());
    const mine = all.filter((l) => l.sessionId === state.session.id).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 50);
    const list = $('historyList');
    list.innerHTML = '';
    if (!mine.length) { list.innerHTML = '<div class="muted">Nothing counted on this scanner yet.</div>'; return; }
    for (const l of mine) {
      const div = document.createElement('div');
      div.className = 'item' + (l.voidedLocal ? ' voided' : '');
      const top = document.createElement('div');
      top.className = 'top';
      const left = document.createElement('span'); left.textContent = `${l.palletId} @ ${l.location}`;
      const right = document.createElement('span'); right.textContent = l.qty;
      top.append(left, right);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${new Date(l.ts).toLocaleTimeString()} · ${l.synced ? 'synced' : 'queued'}` +
        (l.comments ? ` · ${l.comments}` : '') + (l.overrideReason ? ` · flagged: ${l.overrideReason}` : '');
      div.append(top, sub);
      if (!l.voidedLocal) {
        const btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = 'Void this line';
        btn.onclick = async () => {
          await wrap(tx('lines', 'readwrite').put({ ...l, voidedLocal: true }));
          await wrap(tx('dup', 'readwrite').delete(l.palletId));
          if (l.synced && online()) {
            try {
              await api(`/api/sessions/${l.sessionId}/void`, { method: 'POST', body: JSON.stringify({ clientId: l.clientId }) });
              await wrap(tx('lines', 'readwrite').put({ ...l, voidedLocal: true, voidSynced: true }));
            } catch { /* the sync loop retries it */ }
          }
          beep('warn');
          renderHistory();
          updateChips();
        };
        div.appendChild(btn);
      }
      list.appendChild(div);
    }
  }

  /* ------------------------------------------------------------ wiring */
  $('btnSaveDevice').onclick = saveDevice;
  $('fDeviceId').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDevice(); });
  $('btnChangeDevice').onclick = () => { $('fDeviceId').value = state.deviceId; showScreen('scrDevice'); };

  $('btnStart').onclick = signon;
  $('btnRefreshSessions').onclick = loadSessions;
  $('btnAddEmployee').onclick = addEmployee;
  $('fEmployee').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEmployee(); } });
  $('fTeam').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('fEmployee').focus(); } });

  $('btnCount').onclick = () => { showScreen('scrScan'); renderStep(); };
  $('btnAisleDone').onclick = completeAisle;
  $('btnAssignRefresh').onclick = () => refreshAssignment(false);
  $('btnAssignHistory').onclick = () => { renderHistory(); state.historyReturn = 'scrAssign'; showScreen('scrHistory'); };
  $('btnSignoff').onclick = async () => {
    await syncQueue();
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    if (queued > 0 && !confirm(`${queued} line(s) have not reached the server yet. Sign off anyway?`)) return;
    state.team = '';
    state.session = null;
    state.assignment = null;
    updateChips();
    showScreen('scrSignon');
    describeCache();
  };

  $('btnBack').onclick = stepBack;
  $('btnSkip').onclick = () => { $('fScan').value = ''; handleEntry(''); };
  $('btnToAssign').onclick = async () => { await refreshAssignment(true); renderAssignment(); showScreen('scrAssign'); };
  $('btnHistory').onclick = () => { renderHistory(); state.historyReturn = 'scrScan'; showScreen('scrHistory'); };
  $('btnHistoryBack').onclick = () => {
    if (state.historyReturn === 'scrAssign') { renderAssignment(); showScreen('scrAssign'); }
    else { showScreen('scrScan'); renderStep(); }
  };
  $('btnOverrideAccept').onclick = acceptOverride;
  $('btnOverrideCancel').onclick = () => { state.override = null; showScreen('scrScan'); renderStep(); };
  $('btnKeyboard').onclick = () => {
    state.keyboardOn = !state.keyboardOn;
    $('btnKeyboard').textContent = state.keyboardOn ? 'Keyboard on' : 'Keyboard';
    $('fScan').blur();
    renderStep();
  };

  $('fScan').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('fScan').value;
      $('fScan').value = '';
      handleEntry(v);
    }
  });
  $('scrScan').addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') focusScan(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('scrScan').classList.contains('active')) focusScan();
  });

  window.addEventListener('online', () => { updateChips(); syncQueue(); });
  window.addEventListener('offline', updateChips);
  setInterval(() => { updateChips(); syncQueue(); }, 20000);

  /* ------------------------------------------------------------ boot */
  (async () => {
    idb = await openDb();
    state.deviceId = (await metaGet('deviceId')) || '';
    state.employees = (await metaGet('employees')) || [];
    $('fTeam').value = (await metaGet('team')) || '';
    renderEmployees();
    await updateChips();
    await loadSessions();
    await describeCache();
    showScreen(state.deviceId ? 'scrSignon' : 'scrDevice');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* http-only hosts */ });
  })();
})();
