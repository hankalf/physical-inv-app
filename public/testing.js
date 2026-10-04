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
  let dashUrl = '';
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
    setTimeout(coach, 60);           // the gun has moved on: the tip moves with it
    scheduleRefresh();
    if (chip) {
      chip.classList.add('flash');
      setTimeout(() => chip.classList.remove('flash'), 350);
    }
    setTimeout(coach, 350);
    // the count lands on the server a moment after the last scan of a line
    setTimeout(() => refresh().catch(() => {}), 900);
    setTimeout(() => refresh().catch(() => {}), 2500);
  }

  function chip(text, { cls = '', title = '', field = '' } = {}) {
    const b = el('button', 'scan ' + cls, text);
    b.type = 'button';
    b.dataset.code = text;
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
          tr.dataset.bin = b.bin;
          if (p) { tr.dataset.pallet = p.id; tr.dataset.done = p.counted ? '1' : '0'; } else { tr.dataset.empty = '1'; tr.dataset.done = b.counted ? '1' : '0'; }
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
            const opt = (data.options && data.options.values) || {};
            if ((opt.askLot && p.lot) || (opt.askExpiry && p.bestBefore)) {
              const extra = el('div', 'extra');
              if (opt.askLot && p.lot) extra.appendChild(chip(p.lot, { cls: 'lot', title: 'The lot code on the pallet — scan it when the gun asks for the lot' }));
              if (opt.askExpiry && p.bestBefore) extra.appendChild(chip(p.bestBefore, { cls: 'exp', title: 'The best-before date — enter it when the gun asks for the expiry' }));
              tdP.appendChild(extra);
            }
            tdP.appendChild(el('div', 'item' + (p.expired ? ' expired' : ''),
              `${p.desc}${p.uom ? ' · ' + p.uom : ''}${opt.askLot ? '' : ' · lot ' + p.lot} · best before ${p.bestBefore}${p.expired ? ' (expired)' : ''}`));
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
        fix: data.teamsChannel ? '' : 'An SOS still shows on the dashboard. Set the channel under Settings → Advanced to test Teams as well.' }];
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
    { key: 'palletMode', label: 'Pallet ID check', what: 'Allow override (the default) asks YES / NO for a pallet not on the list. No overrides refuses it. Accept any ID does not check at all.', select: [['warn', 'Allow override'], ['strict', 'No overrides'], ['off', 'Accept any ID']] },
    { key: 'autoRecount', label: 'Raise second counts automatically', what: 'Off here until you switch it on (real counts have it on): a pallet that disagrees with the report puts its bin on the second-count list, to try under My aisle → Start second counts.' },
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

  /* The sandbox: the gun's prompts and screen, for this practice alone. Drawn
     only when they change, so a half-typed list is not wiped by the refresh. */
  let sbDrawn = '';
  function renderSandbox() {
    const sb = data.sandbox;
    if (!sb) return;
    const sig = JSON.stringify(sb);
    if (sig === sbDrawn) return;
    sbDrawn = sig;
    $('sbTimeout').value = sb.prompts.commentTimeout;
    $('sbOrder').value = (sb.layout.order || ['pallet', 'qty', 'bin']).join(',');
    $('sbConfirm').value = sb.layout.confirmOver || 0;
    $('sbLarge').checked = sb.layout.textSize === 'large';
    $('sbNextBin').checked = sb.layout.showNextBin !== false;
    $('sbVibrate').checked = sb.layout.vibrate !== false;
    $('sbComments').value = (sb.prompts.comments || []).join('\n');
    $('sbOverrides').value = (sb.prompts.overrides || []).join('\n');
    $('sbSos').value = (sb.sosReasons || []).join('\n');
    const n = sb.overridden.prompts.length + sb.overridden.layout.length + (sb.overridden.sosReasons ? 1 : 0);
    $('sbState').textContent = n ? `${n} setting${n === 1 ? '' : 's'} differ from the site's` : 'same as the site, except the 5-second comments step';
  }
  async function saveSandbox(body, okText) {
    try {
      const next = await api.post('/api/admin/practice/sandbox', body);
      drawn = '';
      render(next);
      msg($('sbMsg'), 'ok', okText, 'The gun picks it up between pallets, within about fifteen seconds.');
    } catch (err) { msg($('sbMsg'), 'err', err.message); }
  }
  $('btnSandboxSave').onclick = () => saveSandbox({
    prompts: { commentTimeout: Number($('sbTimeout').value), comments: $('sbComments').value, overrides: $('sbOverrides').value },
    layout: { order: $('sbOrder').value.split(','), confirmOver: Number($('sbConfirm').value), textSize: $('sbLarge').checked ? 'large' : 'normal',
      showNextBin: $('sbNextBin').checked, vibrate: $('sbVibrate').checked },
    sosReasons: $('sbSos').value,
  }, 'Saved to your sandbox.');
  $('btnSandboxReset').onclick = () => saveSandbox({ reset: true }, 'Back to the site\'s settings (and the 5-second comments step).');

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
    loadDash();
    renderSignon();
    renderChecks();
    renderShelves();
    renderHistory();
    renderReady();
    renderOptions();
    renderSandbox();
    const own = data.source === 'upload';
    $('dataSource').textContent = own ? `testing on “${data.label}”` : 'testing on the built-in data';
    $('btnBuiltIn').hidden = !own;
  }

  /* After a scan the gun posts its line at once, so the sheet is asked again
     shortly, and once more in case the gun was a beat behind. */
  let refreshSoon = 0;
  function scheduleRefresh() {
    if (refreshSoon) return;
    refreshSoon = setTimeout(async () => {
      refreshSoon = 0;
      try { await refresh(); } catch { /* the next tick will */ }
      setTimeout(() => { if (data) refresh().catch(() => {}); }, 1200);
    }, 500);
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
    guideFirstTime();
    tipsFirstTime();
    dashFirstTime();
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

  /* ------------------------------------------------- the first-time guide
     Open until somebody hides it; the choice is kept in this browser. A person
     who has counted here before has read it, so it starts folded for them. */
  /* The guide and the tips come up by themselves the first time a person signs
     in - the server remembers per login, so a shared office computer does not
     hide them from the next new starter. Hiding either tells the server. */
  const GUIDE_KEY = () => `testingGuideHidden:${data ? data.owner : ''}`;
  const tipsSeen = () => { api.post('/api/admin/practice/tips', { seen: true }).catch(() => {}); if (data) data.firstTime = false; };
  function setGuide(hidden, { tell = true } = {}) {
    $('guideCard').classList.toggle('collapsed', hidden);
    $('btnGuide').textContent = hidden ? 'Show me how this works' : 'Hide';
    try { localStorage.setItem(GUIDE_KEY(), hidden ? '1' : '0'); } catch { /* private window */ }
    if (hidden && tell) tipsSeen();
  }
  $('btnGuide').onclick = () => setGuide(!$('guideCard').classList.contains('collapsed'));
  function guideFirstTime() {
    if (data && data.firstTime) { setGuide(false, { tell: false }); return; }
    let saved = null;
    try { saved = localStorage.getItem(GUIDE_KEY()); } catch { saved = null; }
    if (saved !== null) { setGuide(saved === '1', { tell: false }); return; }
    setGuide(true, { tell: false });
  }

  /* ------------------------------------------------- the office side, on top
     The real dashboard, in a frame, locked to this person's practice count
     (?embed=<id>): progress, the pallet report, second counts, adjustments,
     the SOS bar - every function it has, without leaving the page. A new run
     is a new count, so the frame follows the session id. */
  const DASH_KEY = () => `testingDashHidden:${data ? data.owner : ''}`;
  const dashFrame = () => $('dashFrame');
  let dashSeen = false;              // the person has looked at the office side
  function loadDash() {
    if (!data || !data.session) return;
    const url = `/admin?embed=${data.session.id}#progress`;
    if (dashUrl === url) return;
    dashUrl = url;
    dashFrame().src = url;
  }
  /** Switch the dashboard at the top to a sub-tab, and bring it on screen. */
  function dashShow(sub) {
    setDash(false);
    try { const w = dashFrame().contentWindow; if (w && w.appApi && w.appApi.showSub) w.appApi.showSub(sub); } catch { /* still loading */ }
    $('dashCard').scrollIntoView({ block: 'start', behavior: 'smooth' });
    dashSeen = true;
  }
  function setDash(hidden, { tell = true } = {}) {
    $('dashCard').classList.toggle('collapsed', hidden);
    $('btnDashHide').textContent = hidden ? 'Show the dashboard' : 'Hide';
    if (tell) { try { localStorage.setItem(DASH_KEY(), hidden ? '1' : '0'); } catch { /* private window */ } }
  }
  $('btnDashHide').onclick = () => setDash(!$('dashCard').classList.contains('collapsed'));
  $('btnDashTall').onclick = () => {
    const tall = $('dashWrap').classList.toggle('tall');
    $('dashWrap').style.height = '';
    $('btnDashTall').textContent = tall ? 'Shorter' : 'Taller';
  };
  // the same dashboard in a tab of its own, on this count
  $('btnDashboard').onclick = () => {
    if (!data || !data.session) return;
    try { sessionStorage.setItem('searchGoto', JSON.stringify({ page: '/admin', session: data.session.id, sub: 'progress' })); } catch { /* private window */ }
    window.open('/admin#progress', '_blank');
  };
  // clicking into the dashboard counts as having seen it
  window.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement === dashFrame()) dashSeen = true; }, 0); });
  /* A first-timer starts with the dashboard folded away: the gun and the sheet
     are the lesson, and the office side comes at the last step - the guide
     opens it then. Anyone who has chosen since gets what they chose. */
  function dashFirstTime() {
    if (data && data.firstTime) { setDash(true, { tell: false }); return; }
    let saved = null;
    try { saved = localStorage.getItem(DASH_KEY()); } catch { saved = null; }
    setDash(saved === null ? true : saved === '1', { tell: false });
  }

  /* -------------------------------------------------- the guide, step by step
     Six steps, shown one at a time. Each knows when it is done - from what the
     server has and what the gun's screen says - so the guide moves on by
     itself as the person gets through it. Back and Next still work for
     reading ahead; the next thing actually done brings it back on track. */
  const ck = (key) => !!(data && data.checklist.some((c) => c.key === key && c.done));
  const STEPS = [
    { title: 'Check “Before you start”', go: 'readyCard', goText: 'Show me',
      text: 'The <b>Before you start</b> list just below should read <i>ready to test</i>. If anything is not ticked, it says what to do about it. Most of it this page does by itself.',
      done: () => !!data && (data.ready || []).every((r) => r.ok || r.optional) && gunPeek().up },
    { title: 'Sign on', go: 'signonCard', goText: 'Show me',
      text: 'Under <b>1 · Sign on</b>, click the team number <span class="scan">99</span> and a clock-in number — each click is a <b>scan</b> into the gun, exactly as the trigger would be. Then, on the gun itself, tap <b>Sign on &amp; load list</b> and <b>Start counting</b>.',
      done: () => ck('signon') || ['scrAssign', 'scrScan'].includes(gunPeek().screen) },
    { title: 'Count your first pallet', go: 'shelvesCard', goText: 'Show me the shelves',
      text: 'The gun asks three things per pallet, one screen at a time: <b>pallet → quantity → bin</b>. Under <b>3 · What is on the shelves</b>, click those three on the first row, in that order. The comments screen moves on by itself, or tap <b>Skip</b>. The yellow tip follows along and points at the next click.',
      done: () => ck('first') || !!(data && data.totals.lines > 0) },
    { title: 'Work down the sheet', go: 'shelvesCard', goText: 'Show me the shelves',
      text: 'A green edge on a bin means it is counted. Some bins carry a <b>Try this</b> note — the shelf is wrong on purpose there, to show what the gun does about a short pallet, an empty bin, a pallet in the wrong bin, a label that will not scan. Count a few bins and watch.',
      done: () => !!data && data.totals.binsCounted >= 3 },
    { title: 'Watch “Things to try” tick itself off', go: 'checksCard', goText: 'Show me the list',
      text: 'Under <b>2 · Things to try</b> the list fills in from what actually reached the server. Switch a feature on under <b>Try the features that ship turned off</b> and it grows a thing to try for it. When every line is ticked you have seen what a counter meets on the floor.',
      done: () => !!data && data.checklist.length > 0 && data.checklist.every((c) => c.done) },
    { title: 'See the office side', go: 'dash', goText: 'Show me the dashboard',
      text: 'The dashboard at the <b>top of the page</b> is what a supervisor sees of this very count: <b>Progress</b> by aisle, the <b>pallet report</b>, <b>Second counts</b>, <b>Adjustments</b>, and your SOS on its bar. Click through its tabs — it is live, so count another pallet and watch it change.',
      done: () => dashSeen },
  ];
  let stepManual = null;             // where Back / Next left it, if anywhere
  let stepAuto = -1;                 // the first step not yet done
  let stepDrawn = '';
  const stepDone = new Set();        // a step done stays done for the run - the guide never walks backwards
  function renderStepper() {
    if (!data) return;
    const dones = STEPS.map((st, i) => {
      if (stepDone.has(i)) return true;
      let ok = false;
      try { ok = !!st.done(); } catch { ok = false; }
      if (ok) stepDone.add(i);
      return ok;
    });
    const first = dones.indexOf(false);
    const auto = first === -1 ? STEPS.length - 1 : first;
    if (auto !== stepAuto) {                                         // something got done: back on track
      stepAuto = auto; stepManual = null;
      if (auto === STEPS.length - 1 && !dones[auto]) setDash(false, { tell: false });   // the office side: open it up
    }
    const at = stepManual == null ? auto : stepManual;
    const all = first === -1;
    const sig = JSON.stringify([dones, at]);
    if (sig === stepDrawn) return;
    stepDrawn = sig;
    const st = STEPS[at];
    $('stepDots').replaceChildren(...STEPS.map((x, i) => {
      const b = el('button', (dones[i] ? 'done' : '') + (i === at ? ' now' : ''), `${i + 1}`);
      b.type = 'button';
      b.title = x.title;
      b.onclick = () => { stepManual = i; renderStepper(); };
      return b;
    }));
    $('stepN').textContent = `Step ${at + 1} of ${STEPS.length}` + (dones[at] ? ' · done' : '');
    $('stepTitle').textContent = all && at === STEPS.length - 1 ? 'You have seen the lot' : st.title;
    $('stepText').innerHTML = all && at === STEPS.length - 1
      ? 'Every step is done and every thing to try is ticked. <b>Start over</b> begins a fresh run — or switch on a feature under <b>Try the features that ship turned off</b> and count with it on.'
      : st.text;
    $('stepCard').classList.toggle('done', dones[at]);
    $('stepBack').disabled = at === 0;
    $('stepNext').disabled = at === STEPS.length - 1;
    $('stepGo').textContent = st.goText;
    $('stepGo').hidden = all && at === STEPS.length - 1;
    $('stepState').textContent = dones[at] ? (at < STEPS.length - 1 ? 'Done — the next step is up next.' : '') : (at > auto ? `You are on step ${auto + 1} — this is a look ahead.` : '');
  }
  $('stepBack').onclick = () => { stepManual = Math.max(0, (stepManual == null ? stepAuto : stepManual) - 1); renderStepper(); };
  $('stepNext').onclick = () => {
    const at = stepManual == null ? stepAuto : stepManual;
    if (at === STEPS.length - 2) dashSeen = true;      // pressing on to the last step is going to look
    stepManual = Math.min(STEPS.length - 1, at + 1);
    renderStepper();
  };
  $('stepGo').onclick = () => {
    const at = stepManual == null ? stepAuto : stepManual;
    const st = STEPS[at];
    if (st.go === 'dash') { dashShow('progress'); return; }
    const card = $(st.go);
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    card.classList.add('found');
    setTimeout(() => card.classList.remove('found'), 2200);
  };

  /* ------------------------------------------------------------- the coach
     A bubble beside the next thing to click, following what the gun is asking
     for. It reads the gun's own screen - which prompt is up, what is in the
     team box - so it is never a step ahead or behind. */
  const TIPS_KEY = () => `testingTipsOff:${data ? data.owner : ''}`;
  let tipsOff = false;
  let lastTarget = null;
  let lastKey = '';

  function gunPeek() {
    try {
      const d = frame().contentWindow.document;
      const scr = d.querySelector('.screen.active');
      return {
        up: typeof frame().contentWindow.wedge === 'function',
        screen: scr ? scr.id : '',
        prompt: (d.querySelector('#prompt') || {}).textContent || '',
        team: (d.querySelector('#fTeam') || {}).value || '',
        crew: (d.querySelector('#employeeChips') || {}).textContent || '',
        override: scr && scr.id === 'scrOverride' && !!d.querySelector('#ovYesNo:not([hidden])'),
      };
    } catch { return { up: false, screen: '' }; }
  }

  /** The next thing to do: a target to point at, and what to say. */
  function nextTip() {
    const g = gunPeek();
    const lines = data ? data.totals.lines : 0;
    if (!g.up) return { key: 'wait', target: $('gunFrame').closest('.gun'), step: 'Hang on', text: 'The scanner is starting up.' };
    if (g.screen === 'scrSignon') {
      if (!g.team) return { key: 'team', target: $('teamVals').querySelector('.scan'), step: 'Step 1 · sign on', text: 'Click <b>99</b>. Every click on this sheet is a <b>scan</b> — it types into the gun as if you had pulled the trigger.' };
      if (!g.crew.trim()) return { key: 'crew', target: $('crewVals').querySelector('.scan'), step: 'Step 1 · sign on', text: 'Now a clock-in number. Click <b>T1001</b> — that scans a badge in.' };
      return { key: 'start', target: $('gunFrame').closest('.gun'), step: 'Step 1 · sign on', text: 'Now on the gun itself: tap <b>Sign on &amp; load list</b>.', pos: 'left' };
    }
    if (g.screen === 'scrAssign') return { key: 'count', target: $('gunFrame').closest('.gun'), step: 'Step 2', text: 'This is the team\'s aisle. Tap <b>Start counting</b> on the gun.', pos: 'left' };
    if (g.override) return { key: 'yesno', target: $('gunFrame').closest('.gun'), step: 'The gun is asking', text: 'That pallet is not on the report. On the gun, tap <b>YES</b> to count it anyway — it goes to a supervisor as a pallet to add.', pos: 'left' };
    if (g.screen === 'scrScan') {
      const row = [...$('shelves').querySelectorAll('tr[data-pallet][data-done="0"]')].find((r) => !justCounted(r.dataset.pallet)) || null;
      const p = /PALLET/i.test(g.prompt), q = /QUANTITY/i.test(g.prompt), b = /BIN/i.test(g.prompt), c = /Comments/i.test(g.prompt);
      if (p && row) return { key: 'pallet:' + row.dataset.pallet, target: row.querySelector(`.scan[data-code="${row.dataset.pallet}"]`), step: lines ? 'Next pallet' : 'Step 3 · count a pallet',
        text: `The gun wants a <b>pallet</b>. Click <b>${row.dataset.pallet}</b> — that is the pallet on this shelf.${lines ? '' : ' Then it will ask for the quantity, then the bin.'}` };
      if (q && row) return { key: 'qty:' + row.dataset.pallet, target: row.querySelector('.scan.qty'), step: 'Step 3 · count a pallet', text: 'Now the <b>quantity</b>. Click the number — on a real gun the counter keys it in.' };
      if (b && row) return { key: 'bin:' + row.dataset.pallet, target: row.querySelector(`.scan[data-code="${row.dataset.bin}"]`) || $('shelves').querySelector(`.scan[data-code="${row.dataset.bin}"]`), step: 'Step 3 · count a pallet', text: `Last, the <b>bin</b> — click <b>${row.dataset.bin}</b>, the rack label. That saves the line.` };
      const lotQ = /LOT/i.test(g.prompt), expQ = /EXPIRY/i.test(g.prompt);
      if (lotQ && row) return { key: 'lot:' + row.dataset.pallet, target: row.querySelector('.scan.lot') || $('gunFrame').closest('.gun'), step: 'Lot codes are on',
        text: row.querySelector('.scan.lot') ? 'The gun asks for the <b>lot code</b> — click it. A lot that does not match the report is called out on the spot.' : 'The gun asks for the <b>lot code</b>. This pallet has none — tap <b>Skip</b> on the gun.', pos: row.querySelector('.scan.lot') ? '' : 'left' };
      if (expQ && row) return { key: 'exp:' + row.dataset.pallet, target: row.querySelector('.scan.exp') || $('gunFrame').closest('.gun'), step: 'Best-before is on',
        text: row.querySelector('.scan.exp') ? 'Now the <b>best-before date</b> — click it. A date that has passed is flagged for a supervisor.' : 'The gun asks for the <b>best-before date</b>. None on this one — tap <b>Skip</b>.', pos: row.querySelector('.scan.exp') ? '' : 'left' };
      /* a feature switched on in the sandbox gets its moment, once, between pallets */
      if (p) {
        const o = (data.options && data.options.values) || {};
        const x = data.extras || {};
        const feat = (key, t) => (shownFeat.has(key) ? null : { key: 'feat:' + key, ...t });
        const f = (x.openSecondCounts > 0 && feat('second', { target: $('gunFrame').closest('.gun'), step: 'Second counts', pos: 'left',
            text: 'A pallet you counted disagreed with the report, so the gun raised a <b>second count</b>. Tap <b>My aisle</b>, then <b>Start second counts</b>, and count that bin again.' }))
          || (x.pendingApprovals > 0 && feat('approve', { target: $('dashCard'), step: 'Approvals are on',
            text: 'A difference is waiting to be signed for. In the dashboard at the top, open <b>Adjustments</b>: approve it with a reason, or reject it.' }))
          || (o.palletMode === 'strict' && feat('strict', { target: $('fWedge'), step: 'No overrides is on',
            text: 'Type a pallet that is not on the report — <b>F99999-999</b> — and press <b>SCAN</b>. With no overrides, the gun refuses it instead of asking.' }))
          || (o.askComments === false && !shownFeat.has('nocomments') && feat('nocomments', { target: $('gunFrame').closest('.gun'), step: 'Comments step is off', pos: 'left',
            text: 'With the comments step off, the gun goes straight to the next pallet after the bin. Count one and watch.' }));
        if (f) return f;
      }
      if (c) return { key: 'comments', target: $('gunFrame').closest('.gun'), step: 'Comments', text: 'Optional. Tap a reason on the gun, or <b>Skip</b> — or just wait, it moves on by itself.', pos: 'left' };
      if (p && !row) return { key: 'done', target: $('checks'), step: 'All counted', text: 'Every pallet on the sheet is counted. See what is left under <b>Things to try</b> — then look at the dashboard at the top: the office side of what you just did.' };
    }
    if (g.screen === 'scrEmptyRun' || g.screen === 'scrSos' || g.screen === 'scrHistory') return null;
    return null;
  }

  const shownFeat = new Set();     // a feature's tip has had its say once the person moves on
  /* A pallet whose bin was just scanned is counted as far as the tips are
     concerned, straight away - the server and the sheet catch up a moment
     later. The memory is short, so a cancelled scan cannot hide a row for long. */
  const walked = new Map();        // pallet -> when to forget it
  const awaiting = new Map();      // pallet -> when its bin was scanned, until the server shows it counted
  function renderSync() {
    const note = $('syncNote');
    if (!note) return;
    for (const [pal] of awaiting) {
      const row = $('shelves').querySelector(`tr[data-pallet="${pal}"]`);
      if (!row || row.dataset.done === '1') awaiting.delete(pal);
    }
    if (!awaiting.size) { note.className = 'sync ok'; note.textContent = 'Sheet up to date with the server'; return; }
    const [pal, since] = [...awaiting.entries()][0];
    const secs = Math.round((Date.now() - since) / 1000);
    note.className = 'sync wait';
    note.textContent = `Waiting for ${pal} to reach the server${awaiting.size > 1 ? ` (+${awaiting.size - 1} more)` : ''}… ${secs} s — the gun sends it in the background; carry on scanning.`;
    if (secs > 20 && secs % 10 === 0) scheduleRefresh();
  }
  const justCounted = (pallet) => { const t = walked.get(pallet); if (t && t > Date.now()) return true; walked.delete(pallet); return false; };
  function leftTip(key) {
    if (key.startsWith('feat:')) shownFeat.add(key.slice(5));
    if (key.startsWith('bin:')) { walked.set(key.slice(4), Date.now() + 30000); awaiting.set(key.slice(4), Date.now()); scheduleRefresh(); }
  }
  /* A tip only changes once the gun has settled on it: the screens flick past
     between scans, and a bubble that chased every one of them would jump all
     over the page. The same step has to be up for a moment before it shows. */
  let proposed = { key: '', since: 0 };
  const SETTLE_MS = 350;
  function placeCoach(t) {
    const box = $('coach');
    // switching off, or nothing to point at: at once - the wait is only between two live tips
    if (!t || !t.target) { box.hidden = true; if (lastTarget) lastTarget.classList.remove('spot'); if (lastKey) leftTip(lastKey); lastTarget = null; lastKey = ''; proposed = { key: '', since: 0 }; return; }
    if (t.key !== lastKey && lastKey) {
      if (proposed.key !== t.key) proposed = { key: t.key, since: Date.now() };
      if (Date.now() - proposed.since < SETTLE_MS) { if (lastTarget && !lastTarget.isConnected) box.hidden = true; return; }
    }
    if (t.key !== lastKey) {
      leftTip(lastKey);
      // a new step: light the target, bring it on screen, and say so
      if (lastTarget) lastTarget.classList.remove('spot');
      t.target.classList.add('spot');
      lastTarget = t.target;
      lastKey = t.key;
      $('coachStep').textContent = t.step;
      $('coachText').innerHTML = t.text;
      // bring it on screen only when it is off the screen altogether; a nudge, not a leap
      const r = t.target.getBoundingClientRect();
      if (r.bottom < 70 || r.top > window.innerHeight - 40) t.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    box.hidden = false;
    const r = t.target.getBoundingClientRect();
    const w = box.offsetWidth || 300;
    const h = box.offsetHeight || 90;
    box.className = 'coach';
    let top, left;
    if (t.pos === 'left') {           // beside the gun, pointing at it
      box.classList.add('left');
      top = Math.max(12, r.top + 40);
      left = r.left - w - 16;
    } else if (r.bottom + h + 20 < window.innerHeight) {
      box.classList.add('below');
      top = r.bottom + 12; left = r.left - 14;
    } else {
      box.classList.add('above');
      top = r.top - h - 12; left = r.left - 14;
    }
    box.style.top = `${Math.max(8, top)}px`;
    box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  }

  function coach() {
    renderStepper();
    renderSync();
    if (tipsOff || !data || $('scrMain').classList.contains('active') === false) { placeCoach(null); return; }
    placeCoach(nextTip());
  }

  function setTips(off, { tell = true } = {}) {
    tipsOff = off;
    $('btnTips').textContent = off ? 'Show tips' : 'Hide tips';
    try { localStorage.setItem(TIPS_KEY(), off ? '1' : '0'); } catch { /* private window */ }
    if (off && tell) tipsSeen();
    coach();
  }
  $('btnTips').onclick = () => setTips(!tipsOff);
  $('coachOff').onclick = () => setTips(true);
  function tipsFirstTime() {
    // their first sign-in: the tips pop up whatever this computer remembers
    if (data && data.firstTime) { setTips(false, { tell: false }); return; }
    let saved = null;
    try { saved = localStorage.getItem(TIPS_KEY()); } catch { saved = null; }
    if (saved !== null) { setTips(saved === '1', { tell: false }); return; }
    setTips(true, { tell: false });
  }
  setInterval(coach, 200);
  window.addEventListener('scroll', () => coach(), { passive: true });
  window.addEventListener('resize', () => coach());

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

  /* Everything this person has done here - this run and the earlier ones - as
     one workbook, with the same sheets the real Export everything gives. */
  async function exportRuns(btn) {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Building the workbook…';
    try {
      const [out, XLSX] = await Promise.all([api.json('/api/admin/practice/export'), window.appUi.loadXlsx()]);
      const wb = XLSX.utils.book_new();
      for (const sh of out.sheets) {
        const ws = XLSX.utils.json_to_sheet(sh.rows, { header: sh.columns });
        ws['!cols'] = sh.columns.map((c) => ({
          wch: Math.min(60, Math.max(String(c).length, ...sh.rows.slice(0, 500).map((r) => String(r[c] ?? '').length)) + 2),
        }));
        if (sh.rows.length && !/Summary$/.test(sh.name)) ws['!autofilter'] = { ref: ws['!ref'] };
        XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
      }
      XLSX.writeFile(wb, out.filename);
      msg($('rigMsg'), 'ok', `Exported ${out.runs} run${out.runs === 1 ? '' : 's'}.`, `${out.filename} — a Runs sheet, what was tried, then every sheet for each run.`);
    } catch (err) { msg($('rigMsg'), 'err', 'Could not build the export', err.message); }
    finally { btn.disabled = false; btn.textContent = was; }
  }
  $('btnExportMine').onclick = () => exportRuns($('btnExportMine'));
  $('btnExportRuns').onclick = () => exportRuns($('btnExportRuns'));

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
      dashSeen = false; stepManual = null; walked.clear(); awaiting.clear(); stepDone.clear(); stepAuto = -1;
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
    dashSeen = false; stepManual = null; walked.clear(); awaiting.clear(); stepDone.clear(); stepAuto = -1;
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
