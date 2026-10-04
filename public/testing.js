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

      for (const b of data.bins.filter((x) => x.aisle === aisle)) {
        const rows = Math.max(1, b.shelf.length);
        const span = rows + (b.try ? 1 : 0);
        for (let i = 0; i < rows; i++) {
          const p = b.shelf[i];
          const tr = el('tr', (i === 0 ? 'binstart' : '') + (b.counted ? ' counted' : ''));
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
          const tr = el('tr', 'tip' + (b.counted ? ' counted' : ''));
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
  }

  async function refresh() {
    const next = await api.json('/api/admin/practice');
    if (!next.session) return start();
    render(next);
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

  frame().addEventListener('load', () => { $('gunLed').className = 'led'; });

  document.addEventListener('auth', (e) => {
    clearInterval(timer);
    if (!e.detail) return show('login');
    show('main');
    start().catch((err) => msg($('rigMsg'), 'err', 'Could not set up the practice count', err.message));
    timer = setInterval(() => { if (!document.hidden && data) refresh().catch(() => {}); }, 3000);
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
})();
