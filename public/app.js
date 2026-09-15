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
  // the re-key threshold is a site setting now; localStorage stays as an override
  const largeQty = () => Number(localStorage.getItem('largeQtyThreshold') || layoutCfg().confirmOver || 0);
  /* The one-tap reasons and how long the comments step waits are site settings,
     edited in the admin panel. These are only the fallback for a gun that has
     not synced a session yet. */
  const FALLBACK_PROMPTS = {
    comments: ['Damaged', 'Partial pallet', 'Mixed pallet', 'Label unreadable', 'Needs recount', 'Blocked / could not reach'],
    overrides: ['Label unreadable', 'New receipt, not on the report', 'Relabelled', 'Hand-written ID', 'Supervisor said to count it'],
    commentTimeout: 5,
  };
  const prompts = () => state.session?.prompts || FALLBACK_PROMPTS;
  const LAYOUT_FALLBACK = { showContents: true, showNextBin: true, confirmOver: 1000, vibrate: true };
  const layoutCfg = () => state.session?.layout_cfg || LAYOUT_FALLBACK;

  /* Which questions this count asks, in the order the site configured.
     lot and expiry are opt-in per count: a frozen-food count needs them for a
     recall, a spare-parts count would only be slowed down by them. */
  function stepsFor(session) {
    const cfg = session.layout_cfg || {};
    const wanted = new Set(['pallet', 'qty', 'bin',
      ...(session.askLot ? ['lot'] : []), ...(session.askExpiry ? ['expiry'] : [])]);
    return [
      ...(cfg.order || ['pallet', 'qty', 'bin']).filter((k) => wanted.has(k)),
      ...(session.askComments ? ['comments'] : []),
    ];
  }

  const state = {
    deviceId: '',
    deviceUid: '',   // set when this scanner was opened from its registered link
    deviceToken: '', // what it proves itself with from then on
    deviceRejected: '',
    team: '',
    employees: [],
    session: null,     // { id, name, palletMode, guided, askComments, masterVersion }
    assignment: null,  // team-status payload from the server
    crew: null,        // who signed on, and whether they can reach their levels
    steps: [],
    stepIndex: 0,
    draft: {},
    override: null,    // { title, why, rows, apply(reasonText) }
    recounts: [],      // second-count tasks offered to this team
    recount: null,     // the task being worked, if any
    qtyConfirm: null,
    syncing: false,
    keyboardOn: false,
    mode: '',          // 'full' or 'cycle' - what this crew is doing today
    sessions: [],
  };

  const $ = (id) => document.getElementById(id);
  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const titleCase = (z) => String(z || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const aisleLabel = (aisle, zone) => (zone ? `${titleCase(zone)} – Aisle ${aisle}` : `Aisle ${aisle}`);
  const zoneFor = (aisle) => (state.assignment && state.assignment.zones && state.assignment.zones[aisle]) || '';
  const levelsLabel = (l) => {
    if (!l) return 'all levels';
    if (l.length === 1) return `level ${l}`;
    const contiguous = [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1);
    return contiguous ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`;
  };
  // Same code rules as the server: "F01A009" -> aisle F01, level A, position 009.
  function parseBinCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    const parts = code.split(/[-_./\\ ]/).filter(Boolean);
    if (parts.length >= 2) return { aisle: parts[0], bay: parts[1], level: parts[2] || '' };
    const m = /^([A-Z]+\d+)([A-Z])(\d+)$/.exec(code);
    if (m) return { aisle: m[1], level: m[2], bay: m[3] };
    return { aisle: code, bay: '', level: '' };
  }
  // "Level A · Position 009 · FRONT" - what the counter sees after scanning a bin
  function describeBin(code) {
    const p = parseBinCode(code);
    const bits = [];
    if (p.level) bits.push(`Level ${p.level}`);
    if (p.bay) bits.push(`Position ${p.bay}`);
    const faces = state.session && state.session.faces;
    const pos = Number(p.bay);
    if (faces && p.bay && Number.isFinite(pos)) bits.push((pos % 2 === 1 ? faces.odd : faces.even).toUpperCase());
    return bits.join(' · ');
  }
  const levelsFor = (aisle) => { const q = (state.assignment?.queuedDetail || []).find((x) => x.aisle === aisle); return q ? q.levels : ''; };
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
    try { if (navigator.vibrate && layoutCfg().vibrate !== false) navigator.vibrate(kind === 'err' ? [90, 60, 90] : 40); } catch { /* ignore */ }
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
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (state.deviceToken) headers.authorization = 'Device ' + state.deviceToken;
    const res = await fetch(path, { cache: 'no-store', ...options, headers });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      let code = '';
      try { const body = await res.json(); msg = body.error || msg; code = body.code || ''; } catch { /* keep status text */ }
      // the scanner was removed, or its link was reset: say so, keep the lines
      if (res.status === 401 && code === 'device') state.deviceRejected = msg;
      throw Object.assign(new Error(msg), { code, status: res.status });
    }
    return res.json();
  }

  /** A scanner the server will not accept is not a network problem - say which. */
  function renderDeviceProblem() {
    const el = $('deviceProblem');
    if (!el) return;
    el.hidden = !state.deviceRejected;
    if (!state.deviceRejected) return;
    el.className = 'feedback show err';
    el.innerHTML = '';
    el.appendChild(document.createTextNode('This scanner is not signed in'));
    const d = document.createElement('div');
    d.className = 'detail';
    d.textContent = `${state.deviceRejected} Anything already counted is still saved on this scanner and will send once it is authorised again.`;
    el.appendChild(d);
  }

  async function updateChips() {
    renderDeviceProblem();
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    $('chipQueue').hidden = queued === 0;
    $('chipQueue').textContent = queued + ' queued';
    $('chipNet').textContent = online() ? 'online' : 'OFFLINE';
    $('chipNet').className = 'chip ' + (online() ? 'online' : 'offline');
    $('chipDevice').hidden = !state.deviceId;
    $('chipDevice').textContent = state.deviceId + (state.team ? ' · T' + state.team : '');
  }

  /*
   * Site settings change while people are counting.
   *
   * A supervisor edits the one-tap reasons, or the order the questions are
   * asked in, halfway through a shift - and a gun that read them once at
   * sign-on would carry the old ones until somebody signed out and back in.
   * So re-read them with the sync, between pallets where changing the
   * questions cannot strand a half-finished line. `?have=` means the server
   * answers without sending the master list again.
   */
  const SETTINGS_EVERY_MS = 15000;   // the gun syncs on a twenty-second tick anyway
  let settingsReadAt = 0;

  async function refreshSiteSettings() {
    if (!state.session || state.stepIndex !== 0 || state.draft.palletId) return;
    if (Date.now() - settingsReadAt < SETTINGS_EVERY_MS) return;
    settingsReadAt = Date.now();
    const have = await metaGet('masterVersion');
    const fresh = await api(`/api/sessions/${state.session.id}/master?have=${have ?? -1}`);
    if (!fresh || !fresh.unchanged) return;   // a new list: the next sign-on downloads it
    const merged = { ...state.session, ...fresh, id: state.session.id, name: state.session.name };
    state.session = merged;
    await metaSet('session', merged);
    state.steps = stepsFor(merged);
    document.body.classList.toggle('big-text', (merged.layout_cfg || {}).textSize === 'large');
    renderStep();
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
            duplicatePallet: l.duplicatePallet, emptyBin: l.emptyBin || 0, pass: l.pass || 1, recountId: l.recountId || null, overrideReason: l.overrideReason,
            lot: l.lot || null, expiry: l.expiry || null, scannedAt: l.ts,
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
      await flushRecountsDone();
      await refreshSiteSettings();
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
    await metaSet('deviceUid', '');
    await metaSet('deviceToken', '');
    state.deviceId = id;
    state.deviceUid = '';
    state.deviceToken = '';
    $('deviceInfo').textContent = `Scanner ID ${id} was typed on this device (not registered).`;
    updateChips();
    showScreen('scrSignon');
  }

  /* ------------------------------------------------------------ sign-on */
  // Only offer the kinds of work that actually exist, and default to the one
  // this scanner did last.
  function renderSessionChoices() {
    const sel = $('fSession');
    const kinds = new Set(state.sessions.map((s) => s.mode || 'full'));
    $('btnModeFull').hidden = !kinds.has('full');
    $('btnModeCycle').hidden = !kinds.has('cycle');
    $('modeBlock').hidden = kinds.size < 2;
    $('sessionLabel').textContent = kinds.size < 2
      ? (state.mode === 'cycle' ? 'Cycle count' : 'Count session')
      : 'Which one';
    if (!kinds.has(state.mode)) state.mode = kinds.has('full') ? 'full' : [...kinds][0] || '';
    $('btnModeFull').classList.toggle('selected', state.mode === 'full');
    $('btnModeCycle').classList.toggle('selected', state.mode === 'cycle');

    const shown = state.sessions.filter((s) => (s.mode || 'full') === state.mode);
    sel.innerHTML = '';
    for (const s of shown) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name}`;
      o.dataset.session = JSON.stringify(s);
      sel.appendChild(o);
    }
    if (!shown.length) sel.innerHTML = `<option value="">No ${state.mode === 'cycle' ? 'cycle count' : 'full count'} running</option>`;
  }

  async function pickMode(mode) {
    state.mode = mode;
    await metaSet('mode', mode);
    renderSessionChoices();
    const has = (v) => v && [...$('fSession').options].some((o) => o.value === String(v));
    /* A supervisor's default wins over what this gun did last: it is how you
       point every scanner at the wall-to-wall on the morning it starts. */
    const preferred = state.sessions.find((x) => x.isDefault && (x.mode || 'full') === state.mode);
    const last = await metaGet('lastSessionId');
    if (preferred && has(preferred.id)) $('fSession').value = String(preferred.id);
    else if (has(last)) $('fSession').value = String(last);
  }

  async function loadSessions() {
    const sel = $('fSession');
    sel.innerHTML = '';
    try {
      const sessions = await api('/api/sessions');
      if (!sessions.length) { sel.innerHTML = '<option value="">No open sessions on the server</option>'; $('modeBlock').hidden = true; return; }
      state.sessions = sessions;
      await metaSet('sessions', sessions);
      renderSessionChoices();
      const last = await metaGet('lastSessionId');
      if (last && [...sel.options].some((o) => o.value === String(last))) sel.value = String(last);
    } catch (err) {
      const cached = await metaGet('session');
      if (cached) {
        state.sessions = [cached];
        state.mode = cached.mode || 'full';
        renderSessionChoices();
        sel.value = String(cached.id);
        sel.selectedOptions[0].textContent += ' (cached)';
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
    await bulkPut('loc', data.locations, ([c, zone, aisle, level]) => ({ c, zone, aisle, level: level || '' }));
    await bulkPut('pal', data.pallets, ([p, sku, desc, expLoc, lot, expiry]) => ({ p, sku, desc, expLoc, lot, expiry }));
    await metaSet('masterVersion', data.masterVersion);
    await metaSet('cachedAt', Date.now());
    return { bins: data.locations.length, pallets: data.pallets.length, session: data };
  }

  async function signon() {
    clearFeedback($('signonMsg'));
    const team = norm($('fTeam').value);
    if (!team) { feedback($('signonMsg'), 'err', 'Enter your team number'); return; }
    if (norm($('fEmployee').value)) addEmployee();
    if (!state.employees.length) { feedback($('signonMsg'), 'err', 'Add at least one clock in number'); return; }
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
      state.steps = stepsFor(session);
      document.body.classList.toggle('big-text', (session.layout_cfg || {}).textSize === 'large');
      state.draft = {};
      state.stepIndex = 0;
      $('hdrTitle').textContent = `#${session.id} · ${session.name}`;
      $('btnToAssign').hidden = !session.guided && session.mode !== 'cycle';
      if (session.mode === 'cycle') $('btnToAssign').textContent = 'My list';
      updateChips();

      if (online()) {
        try {
          state.assignment = await api(`/api/sessions/${session.id}/signon`, {
            method: 'POST',
            body: JSON.stringify({ deviceId: state.deviceId, deviceUid: state.deviceUid || null, team, employees: state.employees }),
          });
          await metaSet('assignment', state.assignment);
          if (state.assignment.crew) { state.crew = state.assignment.crew; await metaSet('crew', state.crew); }
          await refreshRecounts();
        } catch (err) {
          feedback($('signonMsg'), 'warn', 'Signed on locally only', err.message);
        }
      } else {
        state.assignment = (await metaGet('assignment')) || null;
        state.recounts = (await metaGet('recounts')) || [];
        state.crew = (await metaGet('crew')) || null;
      }
      state.recountsDoneLocal = (await metaGet('recountsDoneLocal')) || [];

      // a cycle session has no aisle plan, but the bin list is the job: show it
      if (session.guided || session.mode === 'cycle') { renderAssignment(); showScreen('scrAssign'); }
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
  async function refreshRecounts() {
    if (!state.session || !online()) return;
    try {
      const r = await api(`/api/sessions/${state.session.id}/recounts?team=${encodeURIComponent(state.team)}`);
      state.recounts = r.tasks || [];
      await metaSet('recounts', state.recounts);
    } catch { /* keep the cached list */ }
  }

  async function refreshAssignment(silent) {
    if (!state.session || !online()) return;
    try {
      const q = `team=${encodeURIComponent(state.team)}&employees=${encodeURIComponent(state.employees.join(','))}`;
      state.assignment = await api(`/api/sessions/${state.session.id}/team-status?${q}`);
      if (state.assignment.crew) { state.crew = state.assignment.crew; await metaSet('crew', state.crew); }
      await metaSet('assignment', state.assignment);
      await refreshRecounts();
      renderAssignment();
    } catch (err) {
      if (!silent) feedback($('assignMsg'), 'warn', 'Could not refresh', err.message);
    }
  }

  async function localCountedBins(aisle) {
    const all = await wrap(tx('lines', 'readonly').getAll());
    const bins = new Set(state.assignment?.bins || []);
    return new Set(all.filter((l) => l.sessionId === state.session.id && !l.voidedLocal && l.aisle === aisle && (!bins.size || bins.has(l.location))).map((l) => l.location));
  }

  /**
   * What the sign-on check found. A badge nobody recognises, somebody rostered
   * to another team, or a crew that cannot reach the levels they were given -
   * none of it stops the count, but the gun says so plainly.
   */
  function renderCrewBanner() {
    const c = state.crew;
    const el = $('crewBanner');
    if (!c || (!c.shortfall && !c.unknown.length && !c.elsewhere.length)) {
      if (c && c.crew.length) {
        el.hidden = false;
        el.className = 'feedback show ok';
        el.innerHTML = '';
        el.appendChild(document.createTextNode(`Signed on: ${c.crew.map((x) => x.name).join(', ')}`));
        const d = document.createElement('div');
        d.className = 'detail';
        d.textContent = `${c.equipmentLabels.length ? c.equipmentLabels.join(' + ') : 'On foot'} · reaches ${levelsLabel(c.reach)}`;
        el.appendChild(d);
      } else el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = 'feedback show ' + (c.shortfall ? 'err' : 'warn');
    el.innerHTML = '';
    el.appendChild(document.createTextNode(c.shortfall ? 'Check your equipment' : 'Check the crew'));
    const lines = [];
    if (c.shortfall) {
      lines.push(c.forAisle && c.forAisle.startsWith('Aisle')
        ? `${c.shortfall.message} ${c.forAisle} was given to team ${state.team} for ${levelsLabel(c.forLevels)}.`
        : `${c.shortfall.message} ${c.forAisle || 'Your work'} covers ${levelsLabel(c.forLevels)}.`);
    }
    if (c.unknown.length) lines.push(`Not on the crew list: ${c.unknown.join(', ')} — check the clock in number, or ask a supervisor to add them.`);
    for (const e of c.elsewhere) lines.push(`${e.name} (${e.badge}) is on team ${e.team} today, not team ${state.team}.`);
    if (c.crew.length) lines.push(`Between you: ${c.equipmentLabels.length ? c.equipmentLabels.join(' + ') : 'on foot only'} — reaches ${levelsLabel(c.reach)}.`);
    for (const t of lines) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = t;
      el.appendChild(d);
    }
    beep(c.shortfall ? 'err' : 'warn');
  }

  async function renderAssignment() {
    renderCrewBanner();
    const a = state.assignment;
    const card = $('assignCard');
    const cycleMode = state.session && state.session.mode === 'cycle';
    if (cycleMode) {
      card.innerHTML = '';
      $('btnAisleDone').hidden = true;
      $('btnCount').hidden = true;
      const tasks = (state.recounts || []).filter((t) => !(state.recountsDoneLocal || []).includes(t.id));
      $('recountCard').hidden = false;
      $('btnRecounts').hidden = !tasks.length;
      $('recountCount').textContent = tasks.length;
      $('recountCardTitle').textContent = 'Cycle count';
      $('recountCardSub').textContent = tasks.length
        ? 'bins on your list — scan every pallet in each, or mark it empty.'
        : 'Nothing on your list right now. Tap Refresh once a supervisor has generated today\'s bins.';
      $('btnRecounts').textContent = 'Start counting the list';
      return;
    }
    $('btnCount').hidden = false;
    clearFeedback($('assignMsg'));
    $('btnAisleDone').hidden = !(a && a.active);
    const tasks = (state.recounts || []).filter((t) => !(state.recountsDoneLocal || []).includes(t.id));
    const cycle = tasks.filter((t) => t.kind === 'cycle').length;
    const cycleOnly = cycle === tasks.length;
    $('recountCard').hidden = !tasks.length;
    $('btnRecounts').hidden = !tasks.length;
    $('recountCount').textContent = tasks.length;
    $('recountCardTitle').textContent = cycleOnly ? 'Cycle count' : cycle ? 'Bins to count' : 'Second counts available';
    $('recountCardSub').textContent = cycleOnly
      ? 'bins on today\'s list — scan every pallet in each, or mark it empty.'
      : 'bins to go back to — the first count didn\'t agree with the inventory report, or a supervisor asked.';
    $('btnRecounts').textContent = cycleOnly ? 'Start counting the list' : 'Start second counts';

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
      box.innerHTML = `<div class="sub">Team ${a.team} — your aisle</div><div class="aisle"></div><div class="sub zone-sub"></div><div class="sub bins-sub"></div><div class="bins"></div>`;
      box.querySelector('.aisle').textContent = a.active.aisle;
      box.querySelector('.zone-sub').textContent = `${aisleLabel(a.active.aisle, a.active.zone)} · ${levelsLabel(a.active.levels)}`;
      box.querySelector('.bins-sub').textContent = `${counted.size} of ${total} bins have a count` +
        (a.queued.length ? ` · next: ${a.queued.map((q) => aisleLabel(q, zoneFor(q)) + (levelsFor(q) ? ' ' + levelsFor(q) : '')).join(', ')}` : ' · last aisle in your plan');
      const grid = box.querySelector('.bins');
      for (const b of a.bins) {
        const s = document.createElement('span');
        s.textContent = b;
        if (counted.has(b)) s.className = 'counted';
        grid.appendChild(s);
      }
      card.appendChild(box);
      $('btnCount').textContent = `Count ${aisleLabel(a.active.aisle, a.active.zone)} (${levelsLabel(a.active.levels)})`;
      return;
    }
    if (a.waitingOn) {
      const w = a.waitingOn;
      card.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'assign waiting';
      box.innerHTML = `<div class="sub">Team ${a.team} — next aisle</div><div class="aisle"></div><div class="sub zone-sub"></div><div class="sub why"></div>`;
      box.querySelector('.aisle').textContent = w.aisle;
      box.querySelector('.zone-sub').textContent = `${aisleLabel(w.aisle, zoneFor(w.aisle))} · ${levelsLabel(w.levels)}`;
      box.querySelector('.why').textContent = w.blockedByTeam
        ? `Waiting: team ${w.blockedByTeam} is still in ${aisleLabel(w.blockedByAisle, zoneFor(w.blockedByAisle))}${w.blockedByLevels ? ' (' + levelsLabel(w.blockedByLevels) + ')' : ''}` +
          `${w.blockedByAisle === w.aisle ? '' : ', which shares racking with ' + w.aisle}. Refresh when they finish.`
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
      ? `Finished: ${a.done.map((q) => aisleLabel(q, zoneFor(q))).join(', ')}. Check with a supervisor for more.`
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

  /* ------------------------------------------------------------ second counts */
  function nextRecountTask() {
    const done = new Set(state.recountsDoneLocal || []);
    const skipped = new Set(state.recountsSkipped || []);
    return (state.recounts || []).find((t) => !done.has(t.id) && !skipped.has(t.id)) || null;
  }

  async function startRecount(task) {
    state.recount = task;
    if (online()) {
      try { await api(`/api/sessions/${state.session.id}/recounts/${task.id}/take`, { method: 'POST', body: JSON.stringify({ team: state.team }) }); }
      catch (err) {
        // somebody else took it, or it is ours to begin with - only a hard refusal stops us
        if (/already has|different team|already done/.test(err.message)) {
          state.recountsSkipped = [...(state.recountsSkipped || []), task.id];
          feedback($('assignMsg'), 'warn', 'That bin was taken by another team', err.message);
          const next = nextRecountTask();
          if (next) return startRecount(next);
          state.recount = null; renderAssignment(); return;
        }
      }
    }
    state.draft = {};
    state.stepIndex = 0;
    showScreen('scrScan');
    renderStep();
  }

  function renderRecountBanner() {
    const t = state.recount;
    $('recountBanner').hidden = !t;
    $('recountRow').hidden = !t;
    if (!t) return;
    $('recountBanner').innerHTML = '';
    $('recountBanner').dataset.bin = t.bin;
    $('recountBanner').dataset.kind = t.kind || 'recount';
    $('recountBanner').appendChild(document.createTextNode(`${t.kind === 'cycle' ? 'CYCLE COUNT' : 'SECOND COUNT'} · bin ${t.bin}`));
    const d = document.createElement('div'); d.className = 'detail';
    d.textContent = `${describeBin(t.bin)} — ${t.reason}. Scan every pallet in this bin, then tap Bin done.`;
    $('recountBanner').appendChild(d);
  }

  async function finishRecount(emptyLine) {
    const t = state.recount;
    if (!t) return;
    state.recountsDoneLocal = [...(state.recountsDoneLocal || []), t.id];
    await metaSet('recountsDoneLocal', state.recountsDoneLocal);
    state.recount = null;
    await flushRecountsDone();
    const next = nextRecountTask();
    if (next) {
      feedback($('scanMsg'), 'ok', `Bin ${t.bin} second count done`, `Next: bin ${next.bin}`);
      await startRecount(next);
      feedback($('scanMsg'), 'ok', `Bin ${t.bin} done`, `Now bin ${next.bin} — ${describeBin(next.bin)}`);
    } else {
      renderAssignment();
      showScreen('scrAssign');
      feedback($('assignMsg'), 'ok', 'All second counts done', 'Nothing more to go back to right now.');
    }
  }

  // completions are queued like count lines, so a recount finished in a dead zone still lands
  async function flushRecountsDone() {
    if (!online() || !state.session) return;
    const pending = [...(state.recountsDoneLocal || [])];
    for (const id of pending) {
      try {
        await api(`/api/sessions/${state.session.id}/recounts/${id}/done`, { method: 'POST', body: JSON.stringify({ team: state.team }) });
        state.recountsDoneLocal = state.recountsDoneLocal.filter((x) => x !== id);
        state.recounts = state.recounts.filter((x) => x.id !== id);
      } catch (err) {
        if (/not found/.test(err.message)) state.recountsDoneLocal = state.recountsDoneLocal.filter((x) => x !== id);
      }
    }
    await metaSet('recountsDoneLocal', state.recountsDoneLocal);
    await metaSet('recounts', state.recounts);
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
    renderRecountBanner();
    const step = state.steps[state.stepIndex];
    $('stepLabel').textContent = `Step ${state.stepIndex + 1} of ${state.steps.length}`;
    $('prompt').textContent = { pallet: 'Scan PALLET ID', qty: 'Enter QUANTITY', bin: 'Scan BIN LOCATION',
      lot: 'Scan LOT CODE', expiry: 'Enter EXPIRY (YYYY-MM-DD)', comments: 'Comments (optional)' }[step];
    const f = $('fScan');
    f.value = '';
    f.placeholder = step === 'comments' ? 'Type a note or tap one below'
      : step === 'expiry' ? 'e.g. 2027-03-15' : '';
    f.inputMode = step === 'qty' ? 'decimal' : (step === 'comments' || step === 'expiry') ? 'text' : (state.keyboardOn ? 'text' : 'none');
    // lot and expiry can be missing on a real pallet, so they are skippable
    $('btnSkip').hidden = !['comments', 'lot', 'expiry'].includes(step);
    $('btnEmpty').hidden = step !== 'pallet';
    $('commentChips').hidden = step !== 'comments';
    if (state.draft.emptyBin && step === 'bin') $('prompt').textContent = 'EMPTY bin — scan its LOCATION';
    if (step === 'comments') {
      const want = prompts().comments.join('\u0000');
      if ($('commentChips').dataset.built !== want) {
        $('commentChips').dataset.built = want;
        $('commentChips').innerHTML = '';
        for (const c of prompts().comments) {
          const b = document.createElement('button');
          b.className = 'chip-btn';
          b.textContent = c;
          b.onclick = () => { holdMoveOn(); f.value = f.value ? f.value + '; ' + c : c; focusScan(); };
          $('commentChips').appendChild(b);
        }
      }
      startMoveOn();
    } else {
      stopMoveOn();
    }
    renderContext();
    renderNextBin();
    focusScan();
  }

  /* ------------------------------------------------- moving on by itself
     Comments are optional, and a counter with both hands full is not going to
     tap Skip on every pallet. So the step counts down and moves on. Touching
     anything - typing, a chip, the keypad - stops the clock, because somebody
     is clearly still writing. */
  let moveOnTimer = null;
  let moveOnLeft = 0;

  function stopMoveOn() {
    if (moveOnTimer) { clearInterval(moveOnTimer); moveOnTimer = null; }
    $('moveOn').hidden = true;
  }
  function holdMoveOn() {
    if (!moveOnTimer) return;
    stopMoveOn();
    $('moveOn').hidden = false;
    $('moveOn').textContent = 'Take your time — tap Skip or press Enter when done';
    $('moveOn').className = 'moveon held';
  }
  function startMoveOn() {
    stopMoveOn();
    const secs = Number(prompts().commentTimeout || 0);
    if (!secs) return;
    moveOnLeft = secs;
    const tick = () => {
      $('moveOn').hidden = false;
      $('moveOn').className = 'moveon';
      $('moveOn').textContent = `Moving on to the next bin in ${moveOnLeft}\u2026`;
      if (moveOnLeft <= 0) {
        stopMoveOn();
        if (state.steps[state.stepIndex] === 'comments') handleEntry($('fScan').value);
        return;
      }
      moveOnLeft -= 1;
    };
    tick();
    moveOnTimer = setInterval(tick, 1000);
  }


  /* --------------------------------------------------- the next bin to count
     Once a team is in an aisle, walking it is a sequence: 001, 002, 003 ... and
     the gun should say which one is next rather than leaving a counter to keep
     their own place down a 650-bin aisle. Scanning something else is still
     fine - the next one is just recomputed. */
  let countedInAisle = new Set();

  async function refreshCounted() {
    const a = state.assignment;
    if (!a || !a.active) { countedInAisle = new Set(); return; }
    countedInAisle = new Set([...(a.progress?.countedBins || []), ...(await localCountedBins(a.active.aisle))]);
  }

  function nextBinCode() {
    const a = state.assignment;
    if (!a || !a.active || !Array.isArray(a.bins)) return null;
    // a.bins is the assigned aisle and levels already; code order is 001, 002, 003 ...
    const ordered = [...a.bins].sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
    return ordered.find((b) => !countedInAisle.has(b)) || null;
  }

  function renderNextBin() {
    const el = $('nextBin');
    const a = state.assignment;
    const onTask = !!state.recount;
    if (onTask || !a || !a.active || !state.session?.guided || !layoutCfg().showNextBin) { el.hidden = true; return; }
    const total = (a.bins || []).length;
    const next = nextBinCode();
    el.hidden = false;
    el.innerHTML = '';
    if (!next) {
      el.className = 'nextbin done';
      el.append(`Every bin in ${a.active.aisle} has a count — tap "Aisle complete" when you are happy.`);
      return;
    }
    el.className = 'nextbin';
    const lead = document.createElement('span');
    lead.className = 'nb-lead';
    lead.textContent = 'Next bin';
    const code = document.createElement('b');
    code.className = 'nb-code';
    code.textContent = next;
    const where = document.createElement('span');
    where.className = 'nb-where';
    where.textContent = describeBin(next) || '';
    const prog = document.createElement('span');
    prog.className = 'nb-prog';
    prog.textContent = `${countedInAisle.size} of ${total}`;
    el.append(lead, code, where, prog);
  }

  async function refreshNextBin() {
    await refreshCounted();
    renderNextBin();
  }

  function renderContext() {
    const d = state.draft;
    const rows = [];
    if (state.session?.guided && state.assignment?.active) rows.push(['Your aisle', `${aisleLabel(state.assignment.active.aisle, state.assignment.active.zone)} · ${levelsLabel(state.assignment.active.levels)}`]);
    if (d.palletId) rows.push(['Pallet', d.palletId]);
    if ((d.description || d.sku) && layoutCfg().showContents !== false) rows.push(['Contents', [d.sku, d.description].filter(Boolean).join(' — ')]);
    if (d.qty != null) rows.push(['Qty', String(d.qty)]);
    if (d.location) rows.push(['Bin', `${d.location}${describeBin(d.location) ? ' — ' + describeBin(d.location) : ''}`]);
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
        state.draft.expectedLot = pal ? (pal.lot || '') : '';
        if (!pal) state.draft.unknownPallet = 1;
      };

      if (dup && !(state.recount && dup.loc === state.recount.bin)) {
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
      /* If the bin was scanned first, this is where a misplaced pallet shows up,
         because the expected location is only known once the pallet is known. */
      const early = state.draft.location && state.draft.expectedLocation && state.draft.expectedLocation !== state.draft.location;
      await advance(early ? 'warn' : 'ok',
        pal ? (pal.desc || pal.sku || value) : `Pallet ${value}`,
        early ? `System expected this pallet in ${state.draft.expectedLocation}, not ${state.draft.location}`
          : (pal ? `Pallet ${value}${pal.sku ? ' · ' + pal.sku : ''}` : 'Not in the pallet list'));
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
      if (largeQty() > 0 && qty >= largeQty() && state.qtyConfirm !== qty) {
        state.qtyConfirm = qty;
        feedback($('scanMsg'), 'warn', `Confirm quantity ${qty}`, 'That is unusually large. Enter it again to accept, or type the correct number.');
        $('fScan').value = '';
        focusScan();
        return;
      }
      state.qtyConfirm = null;
      state.draft.qty = qty;
      await advance('ok', `Qty ${qty}`);
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
      if (state.recount && value !== state.recount.bin) {
        feedback($('scanMsg'), 'err', `This second count is for bin ${state.recount.bin}`, `You scanned ${value}. Scan ${state.recount.bin}, or tap Bin done.`);
        $('fScan').value = ''; focusScan(); return;
      }
      const myLevels = state.recount ? '' : (state.session.guided ? (state.assignment?.active?.levels || '') : '');
      if (state.session.guided && loc.aisle === active && myLevels && loc.level && !myLevels.includes(loc.level)) {
        return askOverride({
          title: 'Not your level',
          why: `Bin ${value} is on level ${loc.level}. Your team is assigned ${levelsLabel(myLevels)} of this aisle.`,
          rows: [['Bin', value], ['Where', describeBin(value)], ['Your levels', levelsLabel(myLevels)]],
          apply: (reason) => { applyBin(); state.draft.offAssignment = 1; addReason(reason); },
          feedbackText: 'Off-level bin accepted',
        });
      }
      if (!state.recount && state.session.guided && loc.aisle !== active) {
        return askOverride({
          title: 'Not your aisle',
          why: active
            ? `Bin ${value} is in aisle ${loc.aisle}. Your team is assigned to aisle ${active}.`
            : `Bin ${value} is in aisle ${loc.aisle}, but your team has no active aisle right now.`,
          rows: [['Bin', value], ['Its aisle', loc.aisle], ['Where', describeBin(value)], ['Your aisle', active || '—']],
          apply: (reason) => { applyBin(); state.draft.offAssignment = 1; addReason(reason); },
          feedbackText: 'Off-aisle bin accepted',
        });
      }
      applyBin();
      if (state.draft.emptyBin) { await commitLine(); return; }
      const where = describeBin(value);
      const misplaced = state.draft.expectedLocation && state.draft.expectedLocation !== value;
      const detail = [where, misplaced ? `System expected this pallet in ${state.draft.expectedLocation}` : ''].filter(Boolean).join(' — ');
      await advance(misplaced ? 'warn' : 'ok', `Bin ${value}`, detail);
      return;
    }

    if (step === 'lot') {
      // an expected lot from the report is worth checking against, not just recording
      const want = state.draft.expectedLot;
      state.draft.lot = value || null;
      if (value && want && want !== value) {
        state.draft.lotMismatch = 1;
        addReason(`lot ${value} where the report says ${want}`);
        await advance('warn', `Lot ${value}`, `The report says this pallet is lot ${want}.`);
      } else {
        await advance('ok', value ? `Lot ${value}` : 'No lot recorded', want && value === want ? 'Matches the report.' : '');
      }
      return;
    }

    if (step === 'expiry') {
      const iso = parseExpiry(raw);
      if (raw && String(raw).trim() && !iso) {
        feedback($('scanMsg'), 'err', 'That is not a date', 'Use YYYY-MM-DD, or tap Skip if the pallet has none.');
        return;
      }
      state.draft.expiry = iso;
      const expired = iso && iso < new Date().toISOString().slice(0, 10);
      if (expired) {
        state.draft.expired = 1;
        addReason(`expired ${iso}`);
        await advance('warn', `Expires ${iso}`, 'That date has passed — flag it to a supervisor.');
      } else {
        await advance('ok', iso ? `Expires ${iso}` : 'No expiry recorded');
      }
      return;
    }

    if (step === 'comments') {
      stopMoveOn();
      // the Enter handler clears the field before calling in, so read what was
      // passed, not the box - reading the box lost every typed note
      state.draft.comments = String(raw == null ? '' : raw).trim() || null;
      await commitLine();
    }
  }

  /** YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, YYMMDD, or a Julian-ish YYYYMMDD. */
  function parseExpiry(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    let m = /^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})$/.exec(t);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(t);
    if (m) {
      // a day over 12 settles it; otherwise take the US order the ERP exports in
      const [, a, b, y] = m;
      return Number(a) > 12 ? `${y}-${b}-${a}` : `${y}-${a}-${b}`;
    }
    m = /^(\d{2})(\d{2})(\d{2})$/.exec(t);
    if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  function addReason(reason) {
    state.draft.overrideReason = state.draft.overrideReason ? `${state.draft.overrideReason} | ${reason}` : reason;
  }

  async function advance(kind, text, detail) {
    feedback($('scanMsg'), kind, text, detail);
    state.stepIndex++;
    // the steps are configurable, so whichever one is last has to be the one
    // that commits - not 'bin' because it happened to be last once
    if (state.stepIndex < state.steps.length) renderStep();
    else await commitLine();
  }

  /* The reasons a counter may pick are a site setting, edited in the admin
     panel - they were hard-coded into the page once, which meant every edit a
     supervisor made stopped at the dashboard and never reached a gun. */
  function renderOverrideReasons() {
    const list = prompts().overrides?.length ? prompts().overrides : FALLBACK_PROMPTS.overrides;
    const want = list.join('\u0000');
    const sel = $('fReason');
    if (sel.dataset.built === want) return;
    sel.dataset.built = want;
    sel.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Choose a reason…';
    sel.appendChild(first);
    for (const r of list) {
      const o = document.createElement('option');
      o.textContent = r;
      sel.appendChild(o);
    }
    // always available: no list of reasons covers everything a warehouse does
    const other = document.createElement('option');
    other.textContent = 'Other';
    sel.appendChild(other);
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
    renderOverrideReasons();
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
    if (state.draft.emptyBin && state.draft.location) { await commitLine(); return; }
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
      palletId: d.emptyBin ? 'EMPTY' : d.palletId,
      qty: d.emptyBin ? 0 : d.qty,
      emptyBin: d.emptyBin ? 1 : 0,
      // a cycle count is the count for that bin, not a second one
      pass: state.recount && state.recount.kind !== 'cycle' ? 2 : 1,
      recountId: state.recount ? state.recount.id : null,
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
      lot: d.lot || null,
      expiry: d.expiry || null,
      ts: new Date().toISOString(),
      synced: 0,
      voidedLocal: false,
    };
    await wrap(tx('lines', 'readwrite').put(line));
    if (!line.emptyBin) await wrap(tx('dup', 'readwrite').put({ p: line.palletId, loc: line.location, team: line.team }));
    updateChips();
    if (line.location) countedInAisle.add(line.location);
    renderNextBin();
    syncQueue();

    state.draft = {};
    state.stepIndex = 0;
    renderStep();
    if (state.recount && line.emptyBin) { await finishRecount(true); return; }
    if (line.emptyBin) feedback($('scanMsg'), 'ok', `Bin ${line.location} recorded as EMPTY`, [describeBin(line.location), line.overrideReason ? 'flagged' : ''].filter(Boolean).join(' — '));
    else feedback($('scanMsg'), 'ok', `Counted ${line.palletId}`,
      `${line.qty}${d.description ? ' × ' + d.description : ''} @ ${line.location}${line.overrideReason ? ' · flagged' : ''}`);
  }

  function stepBack() {
    if (state.draft.emptyBin) { state.draft = {}; state.stepIndex = 0; clearFeedback($('scanMsg')); renderStep(); return; }
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
      const left = document.createElement('span'); left.textContent = l.emptyBin ? `${l.location} — empty` : `${l.palletId} @ ${l.location}`;
      const right = document.createElement('span'); right.textContent = l.emptyBin ? '0' : l.qty;
      top.append(left, right);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${new Date(l.ts).toLocaleTimeString()} · ${l.synced ? 'synced' : 'queued'}${l.pass === 2 ? ' · 2nd count' : ''}` +
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
  $('btnModeFull').onclick = () => pickMode('full');
  $('btnModeCycle').onclick = () => pickMode('cycle');
  $('btnAddEmployee').onclick = addEmployee;
  $('fEmployee').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEmployee(); } });
  $('fTeam').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('fEmployee').focus(); } });

  $('btnCount').onclick = () => { state.recount = null; showScreen('scrScan'); renderStep(); };
  $('btnRecounts').onclick = async () => { const t = nextRecountTask(); if (t) await startRecount(t); };
  $('btnRecountDone').onclick = () => finishRecount(false);
  $('btnRecountSkip').onclick = () => {
    if (!state.recount) return;
    state.recountsSkipped = [...(state.recountsSkipped || []), state.recount.id];
    state.recount = null;
    renderAssignment(); showScreen('scrAssign');
  };
  $('btnAisleDone').onclick = completeAisle;
  $('btnAssignRefresh').onclick = () => refreshAssignment(false);
  $('btnAssignHistory').onclick = () => { renderHistory(); state.historyReturn = 'scrAssign'; showScreen('scrHistory'); };
  $('btnSignoff').onclick = async () => {
    await syncQueue();
    const queued = await wrap(tx('lines', 'readonly').index('synced').count(0));
    if (queued > 0 && !confirm(`${queued} line(s) have not reached the server yet. Sign off anyway?`)) return;
    // signing off ends the crew: the next team scans their own badges in
    state.team = '';
    state.session = null;
    state.assignment = null;
    state.crew = null;
    state.employees = [];
    await metaSet('employees', []);
    await metaSet('crew', null);
    renderEmployees();
    $('fTeam').value = '';
    updateChips();
    showScreen('scrSignon');
    describeCache();
  };

  $('btnBack').onclick = stepBack;
  $('btnEmpty').onclick = () => {
    // jump straight to the bin scan; the line is saved with no pallet and qty 0
    state.draft = { emptyBin: 1 };
    state.stepIndex = state.steps.indexOf('bin');
    renderStep();
    feedback($('scanMsg'), 'warn', 'Empty bin', 'Scan the location of the empty bin.');
  };
  $('btnSkip').onclick = () => { stopMoveOn(); $('fScan').value = ''; handleEntry(''); };
  $('fScan').addEventListener('input', () => { if (state.steps[state.stepIndex] === 'comments') holdMoveOn(); });
  $('btnToAssign').onclick = async () => { state.recount = null; await refreshAssignment(true); renderAssignment(); showScreen('scrAssign'); };
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

  /**
   * A registered scanner is opened from its own link (/?d=<uid>), saved as the
   * home-screen shortcut. The server says which scanner that is; the answer is
   * cached so the app still knows on a cold start with no Wi-Fi.
   */
  async function identifyFromLink() {
    const uid = new URLSearchParams(location.search).get('d');
    if (!uid) return null;
    const cachedUid = await metaGet('deviceUid');
    try {
      // the link is traded for a token; from here on that token is the identity
      const dev = await api('/api/devices/' + encodeURIComponent(uid), { method: 'POST' });
      await metaSet('deviceId', dev.name);
      await metaSet('deviceUid', dev.uid);
      await metaSet('deviceToken', dev.token);
      state.deviceToken = dev.token;
      state.deviceRejected = '';
      return { ok: true, name: dev.name };
    } catch (err) {
      if (/not registered/.test(err.message)) {
        // removed in the dashboard: forget it so nobody counts under a dead id
        if (cachedUid === uid) { await metaSet('deviceId', ''); await metaSet('deviceUid', ''); await metaSet('deviceToken', ''); }
        return { ok: false, reason: 'This scanner link was removed by a supervisor. Ask for a new one.' };
      }
      if (cachedUid === uid) return { ok: true, name: await metaGet('deviceId'), offline: true };
      return { ok: false, reason: 'Cannot reach the server to check this scanner link. Connect to Wi-Fi and reload.' };
    }
  }

  /* ------------------------------------------------------------ boot */
  (async () => {
    idb = await openDb();
    state.deviceToken = (await metaGet('deviceToken')) || '';
    const linked = await identifyFromLink();
    state.deviceId = (await metaGet('deviceId')) || '';
    state.deviceUid = (await metaGet('deviceUid')) || '';
    if (linked && !linked.ok) feedback($('deviceMsg'), 'err', 'Scanner link problem', linked.reason);
    $('deviceInfo').textContent = state.deviceUid
      ? `This scanner is registered as ${state.deviceId}${linked && linked.offline ? ' (offline - using saved identity)' : ''}.`
      : (state.deviceId ? `Scanner ID ${state.deviceId} was typed on this device (not registered).` : '');
    state.employees = (await metaGet('employees')) || [];
    state.mode = (await metaGet('mode')) || '';
    $('fTeam').value = (await metaGet('team')) || '';
    renderEmployees();
    await updateChips();
    await loadSessions();
    await describeCache();
    showScreen(state.deviceId ? 'scrSignon' : 'scrDevice');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* http-only hosts */ });
  })();
})();
