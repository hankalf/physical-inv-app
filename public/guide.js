/* The user guide: the SOP's journeys, with the trouble each step runs into and
   the questions people ask there, a box that answers a question or a pasted
   message, and a look at the count in the picker that says what is missing
   and what you are likely to need next.

   The words live in guide-content.js. This file only shows them, and only
   links to pages this login may open. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $ } = window.appUi;
  const G = window.GUIDE;

  let sessions = [];
  let sessionId = null;
  let journeyKey = '';
  let nowTimer = null;

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  /* -------------------------------------------------------------- links
     A "go" is shown only when the login may open that page; otherwise a quiet
     line says to ask an admin, so the guide never points at a locked door. */
  const mayGo = (g) => !!g && !!g.page && (g.page === '/board' || api.canTab(g.page, g.sub));
  function goLink(g) {
    if (!g || !g.page) return null;
    if (!mayGo(g)) return el('span', 'noway', `(${g.label || g.page} — this login cannot open it; ask an admin)`);
    const a = el('a', 'go', (g.label || g.page) + ' →');
    a.href = g.page + (g.sub ? '#' + g.sub : '');
    a.onclick = (e) => {
      if (g.page === '/board') return;         // a plain page, no sub-tabs
      e.preventDefault();
      api.goto({ page: g.page, sub: g.sub, session: sessionId || undefined });
    };
    return a;
  }

  /* ---------------------------------------------------------------- ticks
     A step done stays ticked in this browser only. */
  const TICKS = 'guide:done';
  let ticks = {};
  try { ticks = JSON.parse(localStorage.getItem(TICKS) || '{}') || {}; } catch { ticks = {}; }
  const tickKey = (jk, i) => `${jk}:${i}`;
  function saveTicks() { try { localStorage.setItem(TICKS, JSON.stringify(ticks)); } catch { /* private window */ } }

  /* ------------------------------------------------------------- searching
     Every step, question and screen message becomes one entry. A query is
     scored by the words it shares with the entry; a pasted message that
     matches a known message nearly whole wins outright. */
  const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'it', 'and', 'or', 'do', 'i', 'we', 'my', 'our', 'how', 'what', 'why', 'does', 'did', 'can', 'not', 'no', 'for', 'be', 'this', 'that', 'with', 'are', 'was', 'says', 'say', 'said', 'me', 'at', 'up', 'get', 'got', 'there', 'when', 'where', 'who', 'into', 'from', 'has', 'have', 'if', 'so', 'as', 'by', 'its', 'one']);
  const SYN = {
    gun: 'scanner', handheld: 'scanner', zebra: 'scanner', device: 'scanner', mc9300: 'scanner', guns: 'scanner',
    tag: 'label', sticker: 'label', barcode: 'label', licence: 'pallet', license: 'pallet', lp: 'pallet', container: 'pallet',
    location: 'bin', slot: 'bin', bay: 'bin', rack: 'aisle',
    wifi: 'signal', network: 'signal', connection: 'signal', internet: 'signal', offline: 'signal',
    password: 'login', username: 'login', account: 'login', user: 'login', permission: 'login', access: 'login',
    recount: 'second', variance: 'adjustment', variances: 'adjustment', difference: 'adjustment', approve: 'adjustment', approval: 'adjustment',
    export: 'erp', file: 'erp', report: 'report', spreadsheet: 'upload', excel: 'upload', csv: 'upload', import: 'upload',
    board: 'board', tv: 'board', teams: 'team', crew: 'team', clockin: 'clock', badge: 'clock',
    lost: 'missing', help: 'sos', emergency: 'sos', alert: 'sos', stuck: 'blocked', keyboard: 'keypad',
    print: 'barcode', printed: 'barcode', slow: 'pace', frozen: 'starting', froze: 'starting', crashed: 'starting',
  };
  const stem = (w) => {
    w = w.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9%]/g, '');
    if (!w) return '';
    w = SYN[w] || w;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    return SYN[w] || w;
  };
  const words = (s) => [...new Set(String(s || '').split(/[\s/—–-]+/).map(stem).filter((w) => w && !STOP.has(w)))];

  let INDEX = null;
  function index() {
    if (INDEX) return INDEX;
    const out = [];
    const add = (entry) => { entry.w = words(entry.title + ' ' + entry.text + ' ' + (entry.extra || '')); entry.lc = (entry.title + ' ' + entry.text).toLowerCase(); out.push(entry); };
    for (const j of G.journeys) {
      j.steps.forEach((st, i) => {
        add({ kind: 'step', title: st.title, text: st.do, extra: j.title, from: `${j.title} · step ${i + 1}`, goto: st.where, j: j.key, i });
        for (const w of st.watch) add({ kind: 'issue', title: w.see, text: `${w.means} ${w.fix}`, extra: st.title + ' ' + j.title, from: `${j.title} · ${st.title}`, goto: st.where, j: j.key, i, means: w.means, fix: w.fix });
        for (const q of st.ask) add({ kind: 'ask', title: q.q, text: q.a, extra: st.title + ' ' + j.title, from: `${j.title} · ${st.title}`, goto: q.goto || st.where, j: j.key, i });
      });
    }
    for (const q of G.questions) add({ kind: 'ask', title: q.q, text: q.a, from: 'General', goto: q.goto });
    for (const e of G.errors) add({ kind: 'issue', title: e.see, text: `${e.means} ${e.fix}`, from: 'What the screen says', goto: e.goto, means: e.means, fix: e.fix });
    INDEX = out;
    return out;
  }

  function search(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const qw = words(q);
    const qlc = q.toLowerCase();
    const scored = [];
    for (const e of index()) {
      let score = 0;
      // a pasted message: the known text inside what was typed, or the other way round
      const t = e.title.toLowerCase();
      if (t.length > 12 && (qlc.includes(t) || (t.includes(qlc) && qlc.length > 10))) score += 50;
      for (const w of qw) {
        if (e.w.includes(w)) score += e.title.toLowerCase().includes(w) ? 4 : 2;
        else if (w.length > 4 && e.w.some((x) => x.startsWith(w) || w.startsWith(x) && x.length > 4)) score += 1;
      }
      if (e.kind === 'issue' && /says?|said|message|error|screen|shows?/.test(qlc)) score += 1;
      if (score > 0) scored.push([score, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, 6).map(([, e]) => e);
    // keep only answers in the same league as the best one
    const best = scored.length ? scored[0][0] : 0;
    return top.filter((e, i) => i === 0 || scored[i][0] * 3 >= best);
  }

  function answerCard(e) {
    const box = el('div', 'answer');
    box.dataset.kind = e.kind;
    box.appendChild(el('div', 'q', e.title));
    if (e.kind === 'issue') {
      const a = el('div', 'a');
      a.append(el('span', 'means', e.means + ' '), el('b', '', e.fix));
      box.appendChild(a);
    } else box.appendChild(el('div', 'a', e.text));
    const go = goLink(e.goto);
    if (go) box.appendChild(go);
    if (e.j) {
      const j = el('a', 'go', 'See the step →');
      j.href = '#' + e.j;
      j.onclick = (ev) => { ev.preventDefault(); openJourney(e.j, e.i); };
      box.appendChild(el('span', '', ' '));
      box.appendChild(j);
    }
    box.appendChild(el('div', 'from', e.from));
    return box;
  }

  function ask() {
    const q = $('askInput').value;
    const out = $('answers');
    out.innerHTML = '';
    const hits = search(q);
    $('askHint').hidden = q.trim().length >= 2;
    if (q.trim().length >= 2 && !hits.length) {
      out.appendChild(el('div', 'muted', 'Nothing in the guide matches those words. Try the words the screen used, or a shorter question — or the search box in the sidebar, which also finds pallets and bins.'));
      return;
    }
    for (const e of hits) out.appendChild(answerCard(e));
  }

  /* ------------------------------------------------------------- right now
     What the APIs say about the count in the picker, each read turned into a
     plain line, and the questions those lines make likely. Anything this login
     may not read is skipped quietly. */
  const safe = (p) => api.json(p).catch(() => null);

  async function rightNow() {
    const list = $('nowList');
    const askBox = $('nowAsk');
    const s = sessions.find((x) => x.id === sessionId);
    $('nowWhich').textContent = s ? `on “${s.name}”` : 'on this count';
    if (!s) {
      list.innerHTML = '';
      list.appendChild(check('warn', 'No count picked', sessions.length ? 'Pick one in the header.' : 'There is no count yet.', { page: '/settings', sub: 'start', label: 'Create one' }));
      askBox.innerHTML = '';
      return;
    }
    const [setup, alerts, progress, devices, hook] = await Promise.all([
      safe(`/api/admin/sessions/${s.id}/setup`),
      api.can('dashboard') ? safe(`/api/admin/sessions/${s.id}/alerts?status=open`) : null,
      api.can('dashboard') ? safe(`/api/admin/sessions/${s.id}/progress`) : null,
      api.can('admin') ? safe('/api/admin/devices') : null,
      api.can('admin') ? safe('/api/admin/teams-webhook') : null,
    ]);
    const checks = [];
    const topics = new Set();

    if (s.status === 'closed') { checks.push(['ok', 'This count is closed', 'Reports and exports still work; scanners cannot add to it.', { page: '/admin', sub: 'reports', label: 'Reports' }]); topics.add('close'); }
    if (s.trial) { checks.push(['warn', 'This is a trial run', 'Nothing goes to the ERP until the trial is ended and the count cleared.', { page: '/settings', sub: 'start', label: 'Count session' }]); topics.add('trial'); }

    if (setup && Array.isArray(setup.steps)) {
      for (const st of setup.steps) {
        if (st.done) continue;
        const level = st.need === 'required' ? 'bad' : st.need === 'wanted' ? 'warn' : 'ok';
        checks.push([level, st.title, st.detail || st.why, st.goto ? { ...st.goto, label: st.label || 'Go' } : null]);
        topics.add(st.key);
      }
      if (setup.steps.every((st) => st.done)) checks.push(['ok', 'Set-up is complete', 'Every step the guided setup asks for is there.', null]);
    }
    if (progress) {
      const open = progress.recounts_open || 0;
      if (open) { checks.push([open > 200 ? 'warn' : 'ok', `${open.toLocaleString()} second counts open`, open > 200 ? 'That is a lot: the thresholds may be at 0.' : 'The guns hand them out nearest first.', { page: '/admin', sub: 'second', label: 'Second counts' }]); topics.add('second'); }
      const done = progress.bins_counted || s.bins_counted || 0;
      const total = progress.bins_total || s.bins || 0;
      if (total && done) checks.push([done >= total ? 'ok' : 'ok', `${done.toLocaleString()} of ${total.toLocaleString()} bins counted`, done >= total ? 'Every bin has a count. Second counts, reports and adjustments are next.' : 'Counting is under way.', { page: '/admin', sub: 'progress', label: 'Progress' }]);
      if (done >= total && total) topics.add('finish');
    }
    if (s.auto_recount && !Number(s.recount_min_qty) && !Number(s.recount_min_pct) && !Number(s.recount_cap)) {
      checks.push(['warn', 'Second-count thresholds are all 0', 'Every difference will raise a second count. Set Recount over, or over %, and a cap.', { page: '/settings', sub: 'start', label: 'Count session' }]);
      topics.add('second');
    }
    if (alerts && alerts.open) { checks.push(['bad', `${alerts.open} SOS open`, 'A counter is waiting. Mark it seen so the gun tells them help is coming.', { page: '/admin', sub: 'alerts', label: 'Alerts' }]); topics.add('sos'); }
    if (devices && Array.isArray(devices.devices)) {
      const n = devices.devices.length;
      const enrolled = devices.devices.filter((d) => d.enrolled_at).length;
      if (n && !enrolled) { checks.push(['warn', 'No scanner has opened its link yet', `${n} registered, none enrolled. Open each link on its device once.`, { page: '/settings', sub: 'gun', label: 'Scanners' }]); topics.add('scanners'); }
    }
    if (hook && !hook.configured) { checks.push(['ok', 'No Teams channel', 'SOS alerts stay on the dashboard and the board. A channel is optional.', { page: '/settings', sub: 'erp', label: 'Integrations' }]); topics.add('teams'); }

    list.innerHTML = '';
    if (!checks.length) list.appendChild(check('ok', 'Nothing to flag', 'The guide sees nothing missing on this count.', null));
    for (const [lvl, t, d, g] of checks) list.appendChild(check(lvl, t, d, g));

    // what people ask next, given what is missing
    askBox.innerHTML = '';
    const likely = predict(topics);
    if (likely.length) {
      askBox.appendChild(el('div', 'sub', 'You will probably want to know'));
      for (const e of likely) askBox.appendChild(answerCard(e));
    }
  }

  function check(level, title, detail, g) {
    const box = el('div', 'check ' + level);
    box.appendChild(el('div', 't', title));
    box.appendChild(el('div', 'd', detail));
    const go = goLink(g);
    if (go) box.appendChild(go);
    return box;
  }

  /* the questions each topic makes likely, by the words in them */
  const TOPIC_Q = {
    bins: ['Does uploading a new bin list wipe the counts?', 'Where do DOORS and WIP go?'],
    pallets: ['Does the column order matter?', 'What about pallets in VA-FR_LOC that are not on the bin list?', 'What does "wanted" mean?'],
    scanners: ['Do I have to install it, or can it run in Chrome?', 'How do I know a gun has the latest version?'],
    blocks: ['What happens with no blocks?'],
    crew: ['What does shift 1 or 2 mean on a team?', 'Can a counter sign on alone?'],
    plan: ['Can a team count an aisle nobody gave them?', 'What does shift 1 or 2 mean on a team?'],
    layout: ['The map is a schematic, not your drawing'],
    batch: ['Do cycle counters need a team number?'],
    second: ['Does the same team recount its own bin?', 'Second-count list is enormous'],
    sos: ['What reasons can a counter pick?', 'Does an SOS work with no Teams channel?'],
    teams: ['Does an SOS work with no Teams channel?'],
    trial: ['Do the guns know it is a trial?'],
    close: ['Can I delete a count?', 'Can I export everything?'],
    finish: ['Does the same team recount its own bin?', 'What does the System column mean?', 'Can I export everything?'],
  };
  function predict(topics) {
    const want = [];
    for (const t of topics) for (const q of TOPIC_Q[t] || []) if (!want.includes(q)) want.push(q);
    const out = [];
    for (const q of want) {
      const e = index().find((x) => x.title === q);
      if (e && !out.includes(e)) out.push(e);
      if (out.length >= 4) break;
    }
    return out;
  }

  /* -------------------------------------------------------------- journeys */
  function drawJourneys() {
    const box = $('journeys');
    box.innerHTML = '';
    for (const j of G.journeys) {
      const b = el('button', 'journey' + (j.key === journeyKey ? ' on' : ''));
      b.type = 'button';
      b.dataset.key = j.key;
      const done = j.steps.filter((_, i) => ticks[tickKey(j.key, i)]).length;
      b.appendChild(el('div', 't', j.title));
      b.appendChild(el('div', 'w', j.who));
      b.appendChild(el('div', 'p', done ? `${done} of ${j.steps.length} steps done` : `${j.steps.length} steps`));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = Math.round((done / j.steps.length) * 100) + '%';
      bar.appendChild(fill);
      b.appendChild(bar);
      b.onclick = () => openJourney(j.key);
      box.appendChild(b);
    }
  }

  function openJourney(key, focusStep) {
    journeyKey = key;
    try { sessionStorage.setItem('guide:journey', key); } catch { /* fine */ }
    drawJourneys();
    const j = G.journeys.find((x) => x.key === key);
    if (!j) return;
    $('stepsTitle').textContent = j.title;
    $('stepsBlurb').textContent = j.blurb;
    const box = $('steps');
    box.innerHTML = '';
    j.steps.forEach((st, i) => {
      const k = tickKey(j.key, i);
      const card = el('div', 'step' + (ticks[k] ? ' done' : ''));
      card.id = `step-${j.key}-${i}`;
      const head = el('div', 'head');
      head.appendChild(el('div', 'num', String(i + 1)));
      head.appendChild(el('h3', '', st.title));
      const tick = el('label', 'tick');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!ticks[k];
      cb.onchange = () => { if (cb.checked) ticks[k] = 1; else delete ticks[k]; saveTicks(); card.classList.toggle('done', cb.checked); drawJourneys(); };
      tick.append(cb, document.createTextNode('done'));
      head.appendChild(tick);
      card.appendChild(head);
      card.appendChild(el('div', 'do', st.do));
      const go = goLink(st.where);
      if (go) card.appendChild(go);
      if (st.watch.length) {
        card.appendChild(el('div', 'sub', 'What tends to go wrong here'));
        for (const w of st.watch) {
          const row = el('div', 'issue');
          row.appendChild(el('div', 'see', w.see));
          row.appendChild(el('div', 'means', w.means));
          row.appendChild(el('div', 'fix', w.fix));
          card.appendChild(row);
        }
      }
      if (st.ask.length) {
        card.appendChild(el('div', 'sub', 'People ask at this point'));
        for (const q of st.ask) {
          const row = el('div', 'askq');
          row.appendChild(el('div', 'q', q.q));
          row.appendChild(el('div', 'a', q.a));
          const g = goLink(q.goto);
          if (g) row.appendChild(g);
          card.appendChild(row);
        }
      }
      box.appendChild(card);
    });
    if (focusStep != null) {
      const target = document.getElementById(`step-${j.key}-${focusStep}`);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.style.outline = '2px solid var(--accent)'; setTimeout(() => { target.style.outline = ''; }, 1800); }
    }
  }

  /* --------------------------------------------------------------- loading */
  const picker = api.sessionPicker('sessionPick', (id) => {
    sessionId = Number(id) || null;
    picker.render(sessions, sessionId);
    rightNow().catch(() => {});
  });

  async function loadSessions() {
    sessions = await api.json('/api/admin/sessions');
    const real = sessions.filter((s) => !s.practice);
    if (!sessionId || !sessions.some((s) => s.id === sessionId)) {
      const open = real.find((s) => s.status !== 'closed') || real[0] || sessions[0];
      sessionId = open ? open.id : null;
    }
    picker.render(sessions, sessionId);
  }

  async function start() {
    INDEX = null;                    // access may have changed what links show
    await loadSessions();
    drawJourneys();
    let key = '';
    try { key = sessionStorage.getItem('guide:journey') || ''; } catch { /* fine */ }
    const fromHash = (location.hash || '').replace('#', '');
    if (G.journeys.some((j) => j.key === fromHash)) key = fromHash;
    openJourney(G.journeys.some((j) => j.key === key) ? key : G.journeys[0].key);
    await rightNow();
    ask();
  }

  $('askInput').addEventListener('input', ask);
  $('askInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('askInput').value = ''; ask(); } });
  $('askClear').onclick = () => { $('askInput').value = ''; ask(); $('askInput').focus(); };

  document.addEventListener('auth', (e) => {
    clearInterval(nowTimer);
    if (!e.detail) return show('login');
    show('main');
    start().catch(() => show('login'));
    nowTimer = setInterval(() => { if (!document.hidden && api.token) rightNow().catch(() => {}); }, 15000);
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
})();
