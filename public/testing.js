/* Testing: the scanner app on a practice count, with the test data beside it.

   The gun on the left is the real app in a frame - the same file the Zebras
   load - opened as a practice gun, so it only ever sees the practice count and
   keeps its own storage. Clicking a value on the sheet "scans" it: the app's own
   wedge hook types it into whichever box would take a scan and presses Enter,
   the way DataWedge does. What staff try here is what counters use. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, table, cell } = window.appUi;
  const frame = () => $('gunFrame');

  let data = null;
  let drawn = '';
  let gunUrl = '';
  let timer = null;

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('practiceChip').hidden = which !== 'main';
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /* ---------------------------------------------------------------- scanning */
  function say(html, kind) {
    const s = $('gunSaid');
    s.innerHTML = '';
    if (typeof html === 'string') s.textContent = html; else s.append(...html);
    const led = $('gunLed');
    led.className = 'led ' + (kind === 'bad' ? 'bad' : 'on');
    clearTimeout(say.t);
    say.t = setTimeout(() => { led.className = 'led'; }, 450);
  }

  function scan(text, chip, field) {
    const w = frame().contentWindow;
    if (!w || typeof w.wedge !== 'function') {
      say('The gun is still starting — give it a second.', 'bad');
      return;
    }
    let ok = false;
    try { ok = w.wedge(text, field); } catch { ok = false; }
    if (!ok) {
      say('Nothing on the gun’s screen takes a scan just now — tap through to the next prompt first.', 'bad');
      return;
    }
    const b = el('b', '', text);
    say(['Scanned ', b], 'ok');
    if (chip) {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 350);
    }
    // the count lands on the server a moment after the last scan of a line
    setTimeout(() => refresh().catch(() => {}), 900);
    setTimeout(() => refresh().catch(() => {}), 2500);
  }

  function chip(text, { cls = '', title = '', field = '' } = {}) {
    const b = el('button', 'scan ' + cls, text);
    b.type = 'button';
    b.title = title || `Scan ${text} into the gun`;
    b.onclick = () => scan(text, b, field || undefined);
    return b;
  }

  /* ---------------------------------------------------------------- the sheet */
  function renderSignon() {
    $('teamVals').replaceChildren(chip(data.team, { title: 'Scan the team number into the gun', field: 'fTeam' }));
    $('crewVals').replaceChildren(...data.crew.map((c) => chip(c, { title: 'Scan this clock-in number into the gun', field: 'fEmployee' })));
  }

  function renderChecks() {
    const done = data.checklist.filter((c) => c.done).length;
    $('checkCount').textContent = `${done} of ${data.checklist.length} done`;
    $('checkMeter').style.width = Math.round((done / data.checklist.length) * 100) + '%';
    $('checks').replaceChildren(...data.checklist.map((c) => {
      const row = el('div', 'check' + (c.done ? ' done' : ''));
      row.dataset.key = c.key;
      row.append(el('i', '', c.done ? '✓' : ''), el('span', '', c.label));
      return row;
    }));
  }

  function palletState(p) {
    if (!p.counted) return el('span', 'state todo', 'not yet');
    if (p.counted.right) return el('span', 'state ok', `✓ ${p.counted.qty}`);
    const bits = [];
    if (Number(p.counted.qty) !== p.qty) bits.push(`${p.counted.qty} counted`);
    if (p.counted.bin !== p.bin) bits.push(`in ${p.counted.bin}`);
    return el('span', 'state warn', `⚠ ${bits.join(', ') || 'counted'}`);
  }

  function renderShelves() {
    const box = $('shelves');
    box.innerHTML = '';
    $('shelfCount').textContent = `${data.totals.binsCounted} of ${data.totals.bins} bins counted · ${data.totals.pallets} pallets on the shelves`;
    const aisles = [...new Set(data.bins.map((b) => b.aisle))];
    const status = new Map(data.assignment.map((a) => [a.aisle, a.status]));
    for (const aisle of aisles) {
      const head = el('div', 'aislehead');
      head.append(el('h3', '', `Aisle ${aisle}`));
      const st = status.get(aisle);
      if (st) head.append(el('span', 'tag ' + (st === 'done' ? 'done' : st === 'active' ? 'active' : 'queued'),
        st === 'done' ? 'done' : st === 'active' ? 'team 99 is here' : 'next'));
      box.appendChild(head);

      const wrap = el('div', 'scroll');
      const t = el('table', 'shelf');
      const hr = el('tr');
      for (const [h, c] of [['Bin', 'c-bin'], ['Pallet on the shelf', ''], ['Qty', 'c-qty'], ['Counted', 'c-state']]) hr.appendChild(el('th', c, h));
      const thead = el('thead');
      thead.appendChild(hr);
      const tbody = el('tbody');

      let band = false;
      for (const b of data.bins.filter((x) => x.aisle === aisle)) {
        band = !band;
        const rows = Math.max(1, b.shelf.length);
        const span = rows + (b.try ? 1 : 0);
        for (let i = 0; i < rows; i++) {
          const p = b.shelf[i];
          const tr = el('tr', (i === 0 ? 'binstart' : '') + (b.counted ? ' counted' : '') + (band ? '' : ' band'));
          if (i === 0) {
            const tdBin = el('td');
            tdBin.rowSpan = span;
            tdBin.appendChild(chip(b.bin, b.noScan === 'bin'
              ? { cls: 'torn', title: 'This rack label will not scan — on the gun tap “Label will not scan” at the bin step. Clicking still scans it, if you want to.' }
              : {}));
            tr.appendChild(tdBin);
          }

          const tdP = el('td');
          const tdQ = el('td');
          const tdS = el('td');
          if (p) {
            p.bin = b.bin;
            tdP.appendChild(chip(p.id, b.noScan === 'pallet'
              ? { cls: 'torn', title: 'This label is torn — on the gun tap “Label will not scan”, then “let me type it”. Clicking here types it for you.' }
              : {}));
            tdP.appendChild(el('div', 'item' + (p.expired ? ' expired' : ''),
              `${p.desc} · lot ${p.lot} · best before ${p.bestBefore}${p.expired ? ' (expired)' : ''}`));
            const rep = [];
            if (!p.report) rep.push('not on the report');
            else {
              if (Number(p.report.qty) !== p.qty) rep.push(`report says ${p.report.qty}`);
              if (p.report.bin && p.report.bin !== b.bin) rep.push(`report says bin ${p.report.bin}`);
            }
            if (rep.length) tdP.appendChild(el('div', 'rep', rep.join(' · ')));
            tdQ.appendChild(chip(String(p.qty), { cls: 'qty', title: 'Scan or key this quantity into the gun' }));
            tdS.appendChild(palletState(p));
          } else {
            tdP.appendChild(el('span', 'none', 'nothing here — the bin is empty'));
            tdS.appendChild(b.recordedEmpty ? el('span', 'state ok', '✓ recorded empty')
              : b.counted ? el('span', 'state warn', '⚠ counted, not as empty') : el('span', 'state todo', 'not yet'));
          }
          if (i === 0) {
            for (const m of b.missing) {
              tdP.appendChild(el('div', 'rep', `report says ${m.id} × ${m.qty} is here — ${m.foundIn ? 'it is in ' + m.foundIn : 'it is not'}`));
            }
          }
          tr.append(tdP, tdQ, tdS);
          tbody.appendChild(tr);
        }
        /* what this bin is here to teach, under its pallets */
        if (b.try) {
          const tr = el('tr', 'tip' + (b.counted ? ' counted' : '') + (band ? '' : ' band'));
          const td = el('td');
          td.colSpan = 3;
          const note = el('div', 'what');
          note.append(el('b', '', 'Try this: '), document.createTextNode(b.try));
          td.appendChild(note);
          tr.appendChild(td);
          tbody.appendChild(tr);
        }
      }
      t.append(thead, tbody);
      wrap.appendChild(t);
      box.appendChild(wrap);
    }
  }

  /* Before you start: what has to be true for the tab to be any use. The gun
     being up is checked here, in the page; the rest comes from the server. */
  function renderReady() {
    const w = frame().contentWindow;
    let gunUp = false;
    try { gunUp = !!(w && typeof w.wedge === 'function'); } catch { gunUp = false; }
    const items = [...(data.ready || []),
      { key: 'gun', ok: gunUp, label: 'The scanner app is running on the left', fix: gunUp ? '' : 'Give it a few seconds, or press Restart the gun.' },
      { key: 'teams', ok: !!data.teamsChannel, optional: true,
        label: data.teamsChannel ? 'Teams channel set — an SOS from the test gun posts there too' : 'Teams channel — not set (optional)',
        fix: data.teamsChannel ? '' : 'An SOS still shows on the dashboard. Set the channel under Settings → Scanners to test Teams as well.' }];
    const todo = items.filter((i) => !i.ok && !i.optional).length;
    $('readySum').textContent = todo ? `${todo} thing${todo === 1 ? '' : 's'} to do first` : 'ready to test';
    $('readySum').style.color = todo ? 'var(--warn)' : 'var(--ok)';
    $('readyList').replaceChildren(...items.map((i) => {
      const row = el('div', 'check' + (i.ok ? ' done' : i.optional ? ' opt' : ''));
      const txt = el('span', '', i.label);
      if (!i.ok && i.fix) txt.appendChild(el('span', 'fix', i.fix));
      row.append(el('i', '', i.ok ? '✓' : i.optional ? '!' : ''), txt);
      return row;
    }));
  }

  /* The features that ship off, one row each: the switch, what it does, and
     whether the practice data has what it needs - with how to add it if not. */
  const OPTIONS = [
    { key: 'askLot', label: 'Ask for the lot code', what: 'The gun adds a LOT CODE question after the quantity, and calls out a lot that does not match the report.' },
    { key: 'askExpiry', label: 'Ask for the best-before date', what: 'The gun adds an EXPIRY question, and flags a date that has already passed.' },
    { key: 'requireApproval', label: 'Adjustments need approval', what: 'Every difference from the report has to be approved, with a reason, before it can go to the ERP. See Dashboard → Adjustments.', more: 'approval' },
    { key: 'trackAbc', label: 'ABC classes & accuracy', what: 'Dashboard → Reports shows count accuracy by A, B and C, against a target for each.' },
    { key: 'palletMode', label: 'Pallet ID check', what: 'Allow override (the default) asks YES / NO for a pallet not on the list. No overrides refuses it. Accept any ID does not check at all.', select: [['warn', 'Allow override'], ['strict', 'No overrides'], ['off', 'Accept any ID']] },
    { key: 'autoRecount', label: 'Raise second counts automatically', what: 'On by default: a pallet that disagrees with the report puts its bin on the second-count list.' },
    { key: 'askComments', label: 'Comments step', what: 'On by default: the optional comments question at the end of each pallet.' },
  ];

  let optDrawn = '';
  function renderOptions() {
    const o = data.options;
    if (!o) return;
    // redrawn only when the options change, so a number half-typed is not wiped by the refresh
    const sig = JSON.stringify(o);
    if (sig === optDrawn) return;
    optDrawn = sig;
    const box = $('optList');
    box.innerHTML = '';
    for (const def of OPTIONS) {
      const row = el('label', 'opt');
      row.dataset.key = def.key;
      let input;
      if (def.select) {
        input = el('select', 'sm');
        for (const [v, l] of def.select) { const op = el('option', '', l); op.value = v; input.appendChild(op); }
        input.value = o.values[def.key];
        input.onchange = () => saveOption({ [def.key]: input.value });
      } else {
        input = el('input');
        input.type = 'checkbox';
        input.checked = !!o.values[def.key];
        input.onchange = () => saveOption({ [def.key]: input.checked });
      }
      row.append(input, el('span', 't', def.label), el('span', 'd', def.what));
      const need = o.needs[def.key];
      if (need) {
        row.appendChild(el('span', 'need ' + (need.ok ? 'ok' : 'no'), (need.ok ? '✓ ' : '⚠ ') + need.text));
        if (!need.ok && need.canDerive) {
          const more = el('span', 'more');
          const b = el('button', 'sm fit', 'Work out ABC classes from the quantities');
          b.type = 'button';
          b.onclick = (e) => { e.preventDefault(); saveOption({ deriveAbc: true }, 'ABC classes worked out.'); };
          more.appendChild(b);
          row.appendChild(more);
        }
      }
      if (def.more === 'approval' && o.values.requireApproval) {
        const more = el('span', 'more');
        const q = el('input', 'sm'); q.type = 'number'; q.min = '0'; q.value = o.values.approvalMinQty;
        const p = el('input', 'sm'); p.type = 'number'; p.min = '0'; p.max = '100'; p.value = o.values.approvalMinPct;
        const go = () => saveOption({ approvalMinQty: Number(q.value) || 0, approvalMinPct: Number(p.value) || 0 });
        q.onchange = go; p.onchange = go;
        more.append('Approve over', q, 'units, or over', p, '% — smaller ones go through by themselves (0 and 0: everything needs approving).');
        row.appendChild(more);
      }
      box.appendChild(row);
    }
  }

  async function saveOption(body, okText) {
    try {
      const next = await api.post('/api/admin/practice/options', body);
      drawn = '';
      render(next);
      msg($('optMsg'), 'ok', okText || 'Saved for your practice count.', 'The gun picks it up the next time it is between pallets.');
    } catch (err) { msg($('optMsg'), 'err', err.message); }
  }

  function renderHistory() {
    const runs = data.history || [];
    $('historyCard').hidden = !runs.length;
    if (!runs.length) return;
    table($('historyTable'),
      [{ label: 'Started' }, { label: 'Finished' }, { label: 'Things tried' }, { label: 'Bins counted', num: true }, { label: 'Lines', num: true }],
      runs, (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(new Date(r.started).toLocaleString()), cell(r.ended ? new Date(r.ended).toLocaleString() : '—'),
          cell(`${r.tried} of ${r.of}`), cell(r.bins, 'num'), cell(r.lines, 'num'));
        return tr;
      });
  }

  function render(next) {
    data = next;
    const sig = JSON.stringify(next);
    if (sig === drawn) return;
    drawn = sig;
    $('gunName').textContent = data.device ? data.device.name : 'MC9300';
    renderSignon();
    renderChecks();
    renderShelves();
    renderHistory();
    renderReady();
    renderOptions();
    const own = data.source === 'upload';
    $('dataSource').textContent = own ? `testing on “${data.label}”` : 'testing on the built-in data';
    $('btnBuiltIn').hidden = !own;
  }

  async function refresh() {
    const next = await api.json('/api/admin/practice');
    if (!next.session) return start();
    render(next);
    renderReady();             // the gun coming up changes this without the server knowing
  }

  /* The practice count is made the first time anybody opens this page. */
  async function start() {
    const next = await api.post('/api/admin/practice', {});
    render(next);
    loadGun();
  }

  function loadGun({ force = false } = {}) {
    const url = `/?d=${encodeURIComponent(data.device.uid)}&practice=1`;
    if (!force && gunUrl === url) return;
    gunUrl = url;
    frame().src = url;
  }

  const waitLoad = (f) => new Promise((res) => { f.addEventListener('load', res, { once: true }); setTimeout(res, 3000); });

  function wipeGunStorage() {
    return new Promise((res) => {
      try {
        const r = indexedDB.deleteDatabase(`invcount-practice-${data.device.uid}`);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      } catch { res(); }
      setTimeout(res, 3000);
    });
  }

  /* ---------------------------------------------------------------- wiring */
  $('btnWedge').onclick = () => {
    const v = $('fWedge').value.trim();
    if (!v) return;
    scan(v);
    $('fWedge').value = '';
    $('fWedge').focus();
  };
  $('fWedge').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btnWedge').click(); } });

  $('btnReloadGun').onclick = () => {
    clearMsg($('rigMsg'));
    try { frame().contentWindow.location.reload(); } catch { loadGun({ force: true }); }
  };

  $('btnDashboard').onclick = () => {
    if (data && data.session) api.goto({ page: '/admin', session: data.session.id, sub: 'progress' });
  };

  $('btnReset').onclick = async () => {
    if (!confirm('Start a new practice run?\n\nThis run is kept under "Your earlier runs", and the test gun starts clean. Real counts are not touched.')) return;
    try {
      const f = frame();
      const gone = waitLoad(f);
      f.src = 'about:blank';           // let go of the gun's storage so it can be wiped
      await gone;
      gunUrl = '';
      const next = await api.post('/api/admin/practice/reset', {});
      await wipeGunStorage();
      drawn = '';
      render(next);
      loadGun({ force: true });
      msg($('rigMsg'), 'ok', 'Started over.', 'A fresh practice run, and a gun that has never seen it. Sign on again — your last run is kept below.');
    } catch (err) { msg($('rigMsg'), 'err', err.message); }
  };

  /* A new run - from a file, or back on the built-in data - swaps the gun's
     storage for a clean one, exactly like Start over. */
  async function newRun(make, okText) {
    const f = frame();
    const gone = waitLoad(f);
    f.src = 'about:blank';
    await gone;
    gunUrl = '';
    const next = await make();
    await wipeGunStorage();
    drawn = '';
    render(next);
    loadGun({ force: true });
    msg($('uploadMsg'), 'ok', okText(next), 'Sign on again on the gun — your last run is kept under “Your earlier runs”.');
  }

  $('btnPracticeUpload').onclick = async () => {
    const file = $('fPracticeFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a file first', 'A CSV or Excel sheet with Bin, Pallet and Qty columns.');
    try {
      const text = await window.appUi.fileToCsv(file);
      await newRun(async () => {
        const res = await api.call(`/api/admin/practice/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'content-type': 'text/csv' }, body: text,
        });
        return res.json();
      }, (n) => `Loaded ${n.totals.pallets} pallets in ${n.totals.bins} bins from ${file.name}.`);
      $('fPracticeFile').value = '';
    } catch (err) { msg($('uploadMsg'), 'err', 'That file did not load', err.message); }
  };
  $('btnBuiltIn').onclick = async () => {
    try {
      await newRun(() => api.post('/api/admin/practice/reset', { builtIn: true }), () => 'Back on the built-in test data.');
    } catch (err) { msg($('uploadMsg'), 'err', err.message); }
  };

  frame().addEventListener('load', () => { $('gunLed').className = 'led'; setTimeout(() => { if (data) renderReady(); }, 1500); });

  document.addEventListener('auth', (e) => {
    clearInterval(timer);
    if (!e.detail) return show('login');
    show('main');
    start().catch((err) => msg($('rigMsg'), 'err', 'Could not set up the practice count', err.message));
    timer = setInterval(() => { if (!document.hidden && data) refresh().catch(() => {}); }, 3000);
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
})();
