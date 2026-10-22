/* Supervisor dashboard: live progress, the warehouse map, team assignments
   (staggered by racking block), alerts from the floor, second counts and the
   pallet report. Making, setting and closing a count lives in /settings. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, cell, tag, table, button } = window.appUi;
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);
  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

  let sessionId = null;
  let sessions = [];
  /* Inside the Testing Suite the page is about one count - the practice count -
     and stays on it whatever the picker would have chosen. */
  const EMBED = api.embed || 0;
  // a practice count is only ever listed to the dashboard inside the Testing Suite, or opened from it in its own tab (?practice=1)
  const WITH_PRACTICE = !!EMBED || new URLSearchParams(location.search).get('practice') === '1';
  /* The same page is Inventory Control at /inventory: the dashboard's second
     counts, adjustments and reports, and an overview of its own. */
  const IC = location.pathname.replace(/\/$/, '') === '/inventory';
  const SESSIONS_URL = '/api/admin/sessions' + (WITH_PRACTICE ? '?practice=1' : IC ? '?inventory=1' : '');
  const PAGE = IC ? '/inventory' : '/admin';

  const needSession = (el) => {
    if (sessionId) return true;
    msg(el, 'err', 'Create a count first', 'Settings → Count setup → Count session makes one.');
    return false;
  };

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('sessionPick').hidden = which !== 'main';
  }

  // the header picker: which count the whole page is about
  const picker = api.sessionPicker('sessionPick', (id) => {
    sessionId = Number(id) || null;
    applySessionSettings();
    refreshAll().catch(() => {});
  });

  // "Freezer – Aisle F01": the zone comes from the bins in the aisle
  const titleCase = (z) => String(z || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const aisleLabel = (aisle, zone) => (zone ? `${titleCase(zone)} – Aisle ${aisle}` : `Aisle ${aisle}`);
  const levelsLabel = (l) => {
    if (!l) return 'all levels';
    if (l.length === 1) return `level ${l}`;
    const contiguous = [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1);
    return contiguous ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`;
  };
  let zoneByAisle = new Map();

  /* ------------------------------------------------------------ sessions */
  async function loadSessions() {
    sessions = await apiJson(SESSIONS_URL);
    // cycle counts switched off for the site: Inventory Control lists none of them
    if (IC && !api.on('cycle')) sessions = sessions.filter((s) => s.mode !== 'cycle');
    const prior = sessionId;
    if (!sessions.length) {
      sessionId = null;
      picker.render([], null);
      applySessionSettings();
      return;
    }
    // an open full count first (the one the scanners land on), else a cycle count
    sessionId = EMBED && sessions.some((s) => s.id === EMBED) ? EMBED
      : sessions.some((s) => s.id === prior) ? prior : (api.defaultSession(sessions) || sessions[0]).id;
    picker.render(sessions, sessionId);
    applySessionSettings();
    await refreshAll();
  }

  // the trial banner above every tab; switching a trial on and off lives under Settings → Count setup
  function renderTrial(s) {
    $('trialBanner').hidden = !(s && s.trial);
  }

  function applySessionSettings() {
    const s = sessions.find((x) => x.id === sessionId);
    renderTrial(s);
    if (!s) return;
    // a cycle session has no aisle plan, so its whole sub-tab goes
    const cycle = s.mode === 'cycle';
    $('teamPlanCard').hidden = cycle;
    const tab = document.querySelector('#subTabs button[data-goto="teams"]');
    if (tab) {
      tab.hidden = cycle;
      if (cycle && tab.classList.contains('current')) api.showSub('progress');
    }
  }

  /* ------------------------------------------------------------ progress */
  async function refreshProgress() {
    const [p, cl] = await Promise.all([
      apiJson(`/api/admin/sessions/${sessionId}/progress`),
      apiJson(`/api/admin/sessions/${sessionId}/clocks`),
    ]);
    clockData = cl;
    renderIdle();
    renderCountClock(cl.count);
    const raw = p.bins_total ? (p.bins_counted / p.bins_total) * 100 : 0;
    // one decimal early on, so the first hour of a big count doesn't read "0%"
    const pct = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    const aislesDone = p.byAisle.filter((a) => a.done_count > 0).length;
    const aislePct = p.byAisle.length ? Math.round((aislesDone / p.byAisle.length) * 100) : 0;
    $('heroPct').textContent = pct;
    $('heroBar').style.width = pct + '%';
    $('heroBarText').textContent = pct >= 100 ? 'COUNT COMPLETE' : `${pct}%`;
    $('heroBins').textContent = `${p.bins_counted.toLocaleString()} of ${p.bins_total.toLocaleString()}`;
    $('aisleBar').style.width = aislePct + '%';
    $('heroAisles').textContent = `${aislesDone} of ${p.byAisle.length} (${aislePct}%)`;
    $('heroSub').textContent = `${p.pallets_counted.toLocaleString()} of ${p.pallets_total.toLocaleString()} listed pallets found` +
      (p.empty_bins ? ` · ${Number(p.empty_bins).toLocaleString()} bins checked empty` : '') + (p.exceptions ? ` · ${p.exceptions} flagged` : '');
    $('stats').innerHTML = '';
    for (const [n, l] of [
      [p.lines.toLocaleString(), 'Count lines'],
      [`${p.pallets_counted.toLocaleString()} / ${p.pallets_total.toLocaleString()}`, `Listed pallets found${p.pallets_unknown ? ` (+${p.pallets_unknown} not on list)` : ''}`],
      [p.teams, 'Teams counting'],
      [p.devices, 'Scanners'],
      [p.exceptions, 'Flagged lines'],
      [`${p.recounts_open} open / ${p.recounts_done} done`, 'Second counts'],
    ]) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      $('stats').appendChild(d);
    }

    zoneByAisle = new Map(p.byAisle.map((a) => [a.aisle, a.zone]));
    // Merge sign-ons (who is on which scanner) with counting activity.
    const byTeam = new Map();
    // who is on the gun: first name and last initial, the clock-in numbers on hover
    for (const s of p.signedOn) byTeam.set(s.team, { team: s.team, devices: s.devices, employees: (s.names || JSON.parse(s.employees || '[]')).join(', '), badges: JSON.parse(s.employees || '[]').join(', '), lines: 0, bins: 0 });
    for (const t of p.byTeam) byTeam.set(t.team, { ...(byTeam.get(t.team) || { team: t.team, employees: '' }), ...t, devices: t.devices });
    lastTeams = byTeam;
    renderTeamTable();

    $('refreshedAt').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  /* ------------------------------------------------------- team clocks
     Each team's time on the count, ticking, and how long since it last
     scanned - amber once it passes the site's stopped-scanning limit. */
  let clockData = { clocks: [], open: [], config: { minutes: 10 } };
  let lastTeams = new Map();
  let shiftFilter = (() => { try { return sessionStorage.getItem('shiftFilter') || ''; } catch { return ''; } })();
  const SHIFT_NAME = { 1: '1st', 2: '2nd' };

  const span = (ms) => {
    if (!(ms >= 0)) return '—';
    const m = Math.floor(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  };

  function renderTeamTable() {
    const clocks = new Map((clockData.clocks || []).map((c) => [c.team, c]));
    const rows = [...lastTeams.values()]
      .map((t) => ({ ...t, clock: clocks.get(t.team) || null }))
      .filter((t) => !shiftFilter || (t.clock && t.clock.shift === shiftFilter))
      .sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true }));
    for (const b of document.querySelectorAll('#shiftFilter button')) b.classList.toggle('selected', b.dataset.shift === shiftFilter);
    const limit = (clockData.config && clockData.config.minutes) || 0;
    const paces = new Map(((clockData.count && clockData.count.teams) || []).map((k) => [k.team, k]));
    table($('teamTable'),
      [{ label: 'Team' }, { label: 'Shift' }, { label: 'Scanner(s)' }, { label: 'Employees' }, { label: 'Active aisle' },
        { label: 'Started' }, { label: 'Time on count' }, { label: 'Downtime' }, { label: 'Last scan' }, { label: 'Lines', num: true }, { label: 'Bins', num: true }, { label: 'Lines / h', num: true }],
      rows,
      (t) => {
        const c = t.clock;
        const k = paces.get(t.team) || null;
        const tr = document.createElement('tr');
        tr.dataset.team = t.team;
        const timer = cell('—', 'timer');
        const quiet = cell(t.last_scan ? new Date(t.last_scan).toLocaleTimeString() : '—', 'quiet');
        if (c && c.started) {
          timer.dataset.start = c.started;
          if (c.endedAt) timer.dataset.end = c.endedAt;
          timer.title = c.working ? 'still counting' : `clock stopped — ${c.state}`;
        }
        if (c && c.working && c.lastActive) {
          quiet.dataset.since = c.lastActive;
          quiet.dataset.limit = limit;
        }
        const st = cell(c ? (c.started ? new Date(c.started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—') : '—');
        if (c && !c.working && c.started) st.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: c.state }));
        /* the team's downtime: its own quiet spells over the limit, amber while one is running */
        const down = cell(k && k.started ? span(k.downtimeMs) : '—');
        if (k && k.quietMinutes != null) { down.classList.add('late'); down.title = `quiet for ${k.quietMinutes} min right now`; }
        else if (k && k.spells) down.title = `${k.spells} quiet spell${k.spells === 1 ? '' : 's'} over ${clockData.count.gapMinutes} min`;
        const pace = cell(k && k.linesPerHour != null ? String(k.linesPerHour) : '—', 'num');
        if (k && k.linesPerHour != null) pace.title = `${k.binsPerHour} bins an hour, over ${span(k.countingMs)} of counting`;
        tr.append(cell(c && c.person ? `${t.team} · ${c.person}` : t.team), cell(c && c.shift ? SHIFT_NAME[c.shift] : '—'), cell(t.devices || '—'), Object.assign(cell(t.employees || '—', 'wrap'), { title: t.badges || '' }),
          (() => { const a = t.active_aisle || (c && c.aisle); return cell(a ? aisleLabel(a, zoneByAisle.get(a)) : '—'); })(),
          st, timer, down, quiet, cell(t.lines || 0, 'num'), cell(t.bins || 0, 'num'), pace);
        return tr;
      }, shiftFilter ? `No ${SHIFT_NAME[shiftFilter]}-shift team on this count yet.` : 'No team has signed on yet.');
    tickClocks();
  }

  /* ------------------------------------------------------ the count clock
     From the first sign-on: how long the count has run, how much of that was
     downtime (nobody on the count scanning for longer than the stopped-scanning
     limit - lunch, a fire drill, the night), how long it was actually counting,
     the pace over the counting time, and when it will be done at the pace of
     the last half hour. The figures tick here; the server is asked every 15 s. */
  let countClockData = null;
  const clockTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  };
  function renderCountClock(c) {
    countClockData = c && c.started ? c : null;
    const box = $('countClock');
    box.innerHTML = '';
    box.hidden = !countClockData;
    if (!countClockData) return;
    const grid = document.createElement('div');
    grid.className = 'grid';
    const stat = (id, label, cls) => {
      const d = document.createElement('div');
      d.className = 'stat' + (cls ? ' ' + cls : '');
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').id = id;
      d.querySelector('.l').id = id + 'L';
      d.querySelector('.l').textContent = label;
      grid.appendChild(d);
    };
    stat('ccElapsed', c.running ? 'On the clock' : 'Took');
    stat('ccDown', `Downtime · quiet over ${c.gapMinutes} min`, 'quiet');
    stat('ccCounting', 'Counting time');
    stat('ccPace', 'Pace');
    stat('ccEta', c.running ? 'Done about' : 'Finished', 'eta');
    box.appendChild(grid);
    box.appendChild(Object.assign(document.createElement('div'), { className: 'spells', id: 'ccSpells' }));
    /* the pace: the last half hour when there is one, the average underneath */
    const r = c.recent;
    const avg = c.binsPerHour != null ? `${c.binsPerHour} bins / h · ${c.linesPerHour} lines / h` : 'no pace yet';
    if (r && r.binsPerHour != null && c.running) {
      $('ccPace').textContent = `${r.binsPerHour} bins / h`;
      $('ccPaceL').textContent = `Pace, last ${r.minutes} min · average ${avg}`;
    } else {
      $('ccPace').textContent = c.binsPerHour != null ? `${c.binsPerHour} bins / h` : '—';
      $('ccPaceL').textContent = c.running ? `Pace, over the counting time · ${c.linesPerHour != null ? c.linesPerHour + ' lines / h' : 'nothing counted yet'}` : `Pace, over the counting time · ${avg}`;
    }
    if (!c.running) { $('ccEta').textContent = clockTime(c.ended); $('ccEtaL').textContent = 'Finished · the last thing anybody did'; }
    else if (!c.binsLeft) { $('ccEta').textContent = 'now'; $('ccEtaL').textContent = 'Done about · every bin has a count'; }
    else if (c.finishAt) {
      $('ccEta').textContent = clockTime(c.finishAt);
      $('ccEtaL').textContent = `Done about · ${c.binsLeft.toLocaleString()} bins left at the ${c.finishBasis === 'recent' ? 'last half hour\'s' : 'average'} pace`;
    } else { $('ccEta').textContent = '—'; $('ccEtaL').textContent = `Done about · ${c.binsLeft.toLocaleString()} bins left, no pace to read it from yet`; }
    tickCountClock();
  }
  function tickCountClock() {
    const c = countClockData;
    if (!c || !$('ccElapsed')) return;
    const now = Date.now();
    let elapsed = c.elapsedMs;
    let down = c.downtimeMs;
    let quietMs = null;
    if (c.running) {
      elapsed = Math.max(0, now - Date.parse(c.started));
      const q = Math.max(0, now - Date.parse(c.lastActivity));
      const isDown = q > c.gapMinutes * 60000;
      down = c.downtimeClosedMs + (isDown ? q : 0);
      if (isDown) quietMs = q;
    }
    $('ccElapsed').textContent = span(elapsed);
    $('ccDown').textContent = span(down);
    $('ccCounting').textContent = span(Math.max(0, elapsed - down));
    const parts = [`Started <b>${clockTime(c.started)}</b>`];
    if (!c.running) parts.push(`ended <b>${clockTime(c.ended)}</b>`);
    const over = c.spells.filter((x) => !x.open);
    parts.push(over.length
      ? `quiet spells: ${over.map((x) => `${clockTime(x.from)}–${clockTime(x.to)} (${span(x.minutes * 60000)})`).join(', ')}`
      : 'no quiet spells over the limit');
    if (quietMs != null) parts.push(`<span class="now">quiet now for ${span(quietMs)}</span>`);
    $('ccSpells').innerHTML = parts.join(' · ');
  }

  /* once a second: the timers move without asking the server anything */
  function tickClocks() {
    tickCountClock();
    const t = Date.now();
    for (const el of document.querySelectorAll('#teamTable td.timer[data-start]')) {
      const end = el.dataset.end ? Date.parse(el.dataset.end) : t;
      el.textContent = span(end - Date.parse(el.dataset.start));
      el.classList.toggle('stopped', !!el.dataset.end);
    }
    for (const el of document.querySelectorAll('#teamTable td.quiet[data-since]')) {
      const mins = Math.floor((t - Date.parse(el.dataset.since)) / 60000);
      const limit = Number(el.dataset.limit) || 0;
      el.textContent = mins < 1 ? 'just now' : `${mins} min ago`;
      el.classList.toggle('late', !!limit && mins >= limit);
    }
  }
  setInterval(tickClocks, 1000);

  for (const b of document.querySelectorAll('#shiftFilter button')) {
    b.onclick = () => {
      shiftFilter = b.dataset.shift;
      try { sessionStorage.setItem('shiftFilter', shiftFilter); } catch { /* private window */ }
      renderTeamTable();
    };
  }

  /* A team that should be counting and is not. Above every tab, like an SOS,
     but amber: worth a look, not a run. */
  function renderIdle() {
    const box = $('idleAlert');
    const open = clockData.open || [];
    const clocks = new Map((clockData.clocks || []).map((c) => [c.team, c]));
    box.innerHTML = '';
    box.hidden = !open.length;
    for (const a of open) {
      const c = clocks.get(a.team) || {};
      const el = document.createElement('div');
      el.className = 'one';
      const grow = document.createElement('div');
      grow.className = 'grow';
      const mins = a.last_scan ? Math.floor((Date.now() - Date.parse(a.last_scan)) / 60000) : null;
      grow.append(
        Object.assign(document.createElement('div'), { className: 'what', textContent: `Team ${a.team} has stopped scanning${mins != null ? ` — ${mins} min` : ''}` }),
        Object.assign(document.createElement('div'), { className: 'who', textContent: [
          c.shift ? `${SHIFT_NAME[c.shift]} shift` : '',
          c.lastBin ? `last bin ${c.lastBin}` : 'nothing scanned yet',
          a.last_scan ? `at ${new Date(a.last_scan).toLocaleTimeString()}` : '',
          a.sent_to === 'teams' ? 'sent to Teams' : '',
        ].filter(Boolean).join(' · ') }));
      const acts = document.createElement('div');
      acts.className = 'acts';
      acts.append(
        button('On break', '', () => answerIdle(a.id, 'break')),
        button('Lunch', '', () => answerIdle(a.id, 'lunch')),
        button('Seen — I am on it', 'primary', () => answerIdle(a.id, 'seen')));
      el.append(grow, acts);
      box.appendChild(el);
    }
  }

  async function answerIdle(id, action) {
    try {
      await postJson(`/api/admin/sessions/${sessionId}/clocks/${id}`, { action });
      clockData = await apiJson(`/api/admin/sessions/${sessionId}/clocks`);
      renderIdle();
      renderTeamTable();
    } catch (err) { msg($('sosAdminMsg'), 'err', err.message); }
  }

  async function refreshClocks() {
    clockData = await apiJson(`/api/admin/sessions/${sessionId}/clocks`);
    renderIdle();
    renderCountClock(clockData.count);
    renderTeamTable();
  }

  /* ---------------------------------------------------- the staggered plan */
  let planShown = null;
  const planBody = () => ({
    teams: $('fPlanTeams').value, shift: $('fPlanShift').value, levels: $('fPlanLevels').value,
    order: $('fPlanOrder').value, replace: $('fPlanReplace').checked, pairs: $('fPlanPairs').checked,
  });

  function renderRules(r) {
    if (!r) return;
    const box = $('planRules');
    const items = [
      [r.paired > 0, `Racking blocks: ${r.paired} of ${r.aisles} aisles paired`, r.paired ? '' : 'Without them, two teams can be sent into back-to-back racking at once. Settings → Lists & racking → Pair the aisles.', '/settings#lists'],
      [r.teamsWithCrew > 0, `Equipment: ${r.teamsWithCrew} of ${r.teams} teams have a crew, so their reach is known`, r.teamsWithCrew ? '' : 'A team with nobody on it is given every level. Put people on teams under Teams & crew.', '/teams'],
      [true, `Levels in this count: ${r.levels ? r.levels.split('').join(', ') : 'none yet'}`, '', ''],
    ];
    box.innerHTML = '';
    for (const [ok, text, fix, href] of items) {
      const d = document.createElement('div');
      d.className = 'rule ' + (ok ? 'ok' : 'no');
      d.append(Object.assign(document.createElement('i'), { textContent: ok ? '✓' : '!' }), document.createTextNode(text));
      if (!ok && fix) {
        const a = document.createElement('a');
        a.href = href; a.textContent = ' ' + fix;
        d.appendChild(a);
      }
      box.appendChild(d);
    }
  }

  function renderPlan(plan, applied) {
    planShown = plan;
    renderRules(plan.rules);
    const out = $('planOut');
    out.innerHTML = '';
    out.hidden = false;
    for (const t of plan.teams) {
      const row = document.createElement('div');
      row.className = 'planrow' + (t.aisles.length ? '' : ' none');
      const head = document.createElement('div');
      head.className = 'ph';
      head.append(Object.assign(document.createElement('b'), { textContent: `Team ${t.team}` }));
      head.append(Object.assign(document.createElement('span'), { className: 'muted',
        textContent: [t.shift ? (t.shift === '1' ? '1st shift' : '2nd shift') : '', t.known ? `reaches ${levelsLabel(t.reach)}` : 'no crew on Teams & crew — given every level',
          `${t.bins.toLocaleString()} bins`].filter(Boolean).join(' · ') }));
      row.appendChild(head);
      row.appendChild(Object.assign(document.createElement('div'), { className: 'pa', textContent: t.text || '— nothing —' }));
      out.appendChild(row);
    }
    if (plan.teams.some((t) => t.aisles.some((a) => a.extra))) {
      out.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: '* levels another team could not reach, taken after this team\'s own stretch' }));
    }
    for (const w of plan.warnings) out.appendChild(Object.assign(document.createElement('div'), { className: 'pwarn', textContent: w }));
    for (const u of plan.unassigned) out.appendChild(Object.assign(document.createElement('div'), { className: 'pbad', textContent: `${u.aisle} ${levelsLabel(u.levels)}: ${u.why}` }));
    if (plan.skipped.length) {
      out.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: `Left as they are: ${plan.skipped.map((s) => `${s.aisle} (${s.why})`).join(', ')}` }));
    }
    $('btnPlanApply').disabled = applied || !plan.teams.some((t) => t.aisles.length);
  }

  $('btnPlanPreview').onclick = async () => {
    try {
      clearMsg($('planMsg'));
      renderPlan(await postJson(`/api/admin/sessions/${sessionId}/assignments/auto`, { ...planBody(), preview: true }), false);
      msg($('planMsg'), 'warn', 'This is a preview — nothing is queued yet.', 'Queue this plan puts it on the scanners.');
    } catch (err) { msg($('planMsg'), 'err', err.message); }
  };
  $('btnPlanApply').onclick = async () => {
    if (!planShown) return;
    const n = planShown.teams.reduce((k, t) => k + t.aisles.length, 0);
    if (!confirm(`Queue ${n} aisle assignments across ${planShown.teams.filter((t) => t.aisles.length).length} teams?${$('fPlanReplace').checked ? '\n\nEverything still queued is replaced.' : ''}`)) return;
    try {
      const out = await postJson(`/api/admin/sessions/${sessionId}/assignments/auto`, planBody());
      renderPlan(out, true);
      msg($('planMsg'), 'ok', `Queued ${out.queued} aisle assignments.`, out.activated.length ? `Started now: ${out.activated.map((a) => `team ${a.team} on ${a.aisle}`).join(', ')}.` : '');
      await refreshAssignments();
    } catch (err) { msg($('planMsg'), 'err', err.message); }
  };
  for (const id of ['fPlanTeams', 'fPlanShift', 'fPlanLevels', 'fPlanOrder', 'fPlanReplace', 'fPlanPairs']) {
    $(id).addEventListener('change', () => { $('btnPlanApply').disabled = true; });    // a changed form needs a fresh preview
  }

  /* ------------------------------------------------------------ assignments
     The planning board: the aisles nobody has planned on the left, a column
     per team on the right with each aisle as a card - counting now with how
     far it is, next, held while another team has the racking, or done.
     Aisles are dragged from the list onto a team, up and down a team's queue,
     across to another team, or back to the list to come off the plan. */
  const drag = { kind: '', aisle: '', id: 0, team: '' };
  const dragKind = (e) => { try { const d = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); return d.kind ? d : drag; } catch { return drag; } };
  /* "ABCDEF" -> "A-F", for the Levels box */
  const levelsBox = (l) => (!l ? '' : [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1) ? (l.length === 1 ? l : `${l[0]}-${l[l.length - 1]}`) : [...l].join(','));
  const planAct = async (fn, okMsg) => {
    try { const out = await fn(); clearMsg($('assignMsg')); if (okMsg) okMsg(out); await refreshAll(); }
    catch (err) { msg($('assignMsg'), 'err', err.message); }
  };
  /* an aisle dropped on a team: queued with the levels the team reaches; a team that cannot reach them may still be told to */
  async function queueDropped(team, aisle, reach) {
    const levels = reach ? levelsBox(reach) : 'A-F';
    const go = (force) => postJson(`/api/admin/sessions/${sessionId}/assignments`, { team, aisles: aisle, levels, direction: 'up', force });
    await planAct(async () => {
      let r;
      try { r = await go(false); }
      catch (err) { if (!/cannot reach level/.test(err.message) || !confirm(`${err.message}\n\nAssign it anyway?`)) throw err; r = await go(true); }
      return r;
    }, (r) => {
      const started = (r.activated || []).find((a) => a.team === team);
      if (r.skipped.length) msg($('assignMsg'), 'warn', r.skipped.map((s) => `${s.aisle}: ${s.reason}`).join(' · '));
      else msg($('assignMsg'), 'ok', `${aisle} queued for team ${team}, ${reach ? levelsLabel(reach) : 'every level'}.`, started ? 'It started now.' : '');
    });
  }
  async function refreshAssignments() {
    if (!planShown) postJson(`/api/admin/sessions/${sessionId}/assignments/auto`, { preview: true, teams: 'x' }).then((p) => renderRules(p.rules)).catch(() => {});
    const [rows, aisles, crew] = await Promise.all([
      apiJson(`/api/admin/sessions/${sessionId}/assignments`),
      apiJson(`/api/admin/sessions/${sessionId}/aisles`),
      // the teams on Teams & crew: each gets a column on the plan before anything is queued for it
      apiJson(`/api/admin/sessions/${sessionId}/plan`).catch(() => ({ teams: [] })),
    ]);
    const can = api.can('assign');
    const crewTeams = new Map((crew.teams || []).map((t) => [String(t.name), t]));
    $('planTeamNames').replaceChildren(...[...crewTeams.keys()].map((n) => Object.assign(document.createElement('option'), { value: n })));
    const byAisle = new Map(aisles.map((a) => [a.aisle, a]));
    const blockOf = new Map(aisles.map((a) => [a.aisle, a.block]));
    const activeInBlock = new Map(); // block -> [{team, levels}]
    const overlap = (a, b) => !a || !b || [...a].some((c) => b.includes(c));
    for (const r of rows) if (r.status === 'active') { const k = blockOf.get(r.aisle) || r.aisle; if (!activeInBlock.has(k)) activeInBlock.set(k, []); activeInBlock.get(k).push(r); }

    const teams = new Map();
    for (const name of crewTeams.keys()) teams.set(name, []);
    for (const r of rows) { if (!teams.has(r.team)) teams.set(r.team, []); teams.get(r.team).push(r); }

    /* ---- the aisles nobody has planned ---- */
    const planned = new Set(rows.map((r) => r.aisle));
    const pool = aisles.filter((a) => !planned.has(a.aisle)).sort((a, b) => String(a.zone || '').localeCompare(String(b.zone || '')) || a.aisle.localeCompare(b.aisle, undefined, { numeric: true }));
    const q = ($('poolFilter').value || '').trim().toUpperCase();
    const list = $('poolList');
    list.innerHTML = '';
    $('poolCount').textContent = pool.length ? `${pool.length} of ${aisles.length}` : aisles.length ? 'every aisle is planned' : '';
    for (const a of pool) {
      if (q && !`${a.aisle} ${a.zone || ''}`.toUpperCase().includes(q)) continue;
      const el = document.createElement('div');
      el.className = 'pool-aisle';
      el.dataset.aisle = a.aisle;
      el.draggable = can;
      el.title = can ? `Drag ${a.aisle} onto a team, or click to put it in the Aisles box` : `${a.bins} bins`;
      el.append(Object.assign(document.createElement('b'), { textContent: a.aisle }),
        Object.assign(document.createElement('span'), { className: 'z', textContent: a.zone ? titleCase(a.zone) : '' }),
        Object.assign(document.createElement('span'), { className: 'n', textContent: a.bins_counted ? `${a.bins_counted}/${a.bins} bins` : `${a.bins} bins` }));
      el.addEventListener('dragstart', (e) => { Object.assign(drag, { kind: 'aisle', aisle: a.aisle, id: 0, team: '' }); e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'aisle', aisle: a.aisle })); e.dataTransfer.effectAllowed = 'move'; });
      el.addEventListener('click', () => { const f = $('fAssignAisles'); const have = f.value.split(/[,\s]+/).filter(Boolean); if (!have.includes(a.aisle)) f.value = [...have, a.aisle].join(', '); f.focus(); });
      list.appendChild(el);
    }
    if (!pool.length) list.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: aisles.length ? 'Every aisle is on a team\'s plan.' : 'No aisles yet — upload the bin list under Settings.' }));
    else if (!list.childNodes.length) list.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'No aisle matches.' }));

    /* ---- a column per team ---- */
    const board = $('teamList');
    board.innerHTML = '';
    const counting = rows.filter((r) => r.status === 'active').length, queued = rows.filter((r) => r.status === 'queued').length, done = rows.filter((r) => r.status === 'done').length;
    $('planSummary').textContent = teams.size ? `${teams.size} team${teams.size === 1 ? '' : 's'} · ${counting} counting · ${queued} queued · ${done} done · ${pool.length} aisle${pool.length === 1 ? '' : 's'} not planned` : '';
    if (!teams.size) { board.innerHTML = '<div class="muted">No teams yet. Add them on Teams &amp; crew, queue aisles above, or upload a counting plan.</div>'; return; }

    for (const [team, items] of [...teams.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))) {
      const box = document.createElement('div');
      box.className = 'team';
      box.dataset.team = team;
      const ct = crewTeams.get(String(team));
      const active = items.find((i) => i.status === 'active');
      const head = document.createElement('div');
      head.className = 'head';
      head.innerHTML = `<span>Team <b></b></span><span class="muted"></span>`;
      head.querySelector('b').textContent = team;
      head.querySelector('.muted').textContent = !items.length ? 'nothing queued'
        : active ? `in ${aisleLabel(active.aisle, zoneByAisle.get(active.aisle))}, ${levelsLabel(active.levels)}` : (items.every((i) => i.status === 'done') ? 'finished' : 'waiting');
      box.appendChild(head);
      const meta = [ct && ct.shift ? (ct.shift === '1' ? '1st shift' : '2nd shift') : '', ct && ct.reach ? `reaches ${ct.reachLabel}` : '', ct ? (ct.people ? `${ct.people} ${ct.people === 1 ? 'person' : 'people'}` : 'nobody on it yet') : 'not on Teams & crew'].filter(Boolean).join(' · ');
      if (meta) box.appendChild(Object.assign(document.createElement('div'), { className: 'tmeta', textContent: meta }));
      if (!items.length) box.classList.add('empty');

      const seq = document.createElement('div');
      seq.className = 'seq';
      const sorted = items.sort((a, b) => (a.status === 'done' ? 0 : 1) - (b.status === 'done' ? 0 : 1) || a.position - b.position || a.id - b.id);
      let nextSeen = false;
      for (const it of sorted) {
        const ov = byAisle.get(it.aisle) || {};
        const a = document.createElement('div');
        a.className = 'a ' + it.status;
        a.dataset.id = it.id;
        // a team coming the other way down the same aisle is a partner, not a hold
        const holder = (activeInBlock.get(blockOf.get(it.aisle) || it.aisle) || []).find((h) => h.team !== team && overlap(h.levels, it.levels)
          && !(h.aisle === it.aisle && (h.direction || 'up') !== (it.direction || 'up')));
        const blocked = it.status === 'queued' && !!holder;
        if (blocked) a.classList.add('blocked');
        a.title = blocked ? `Held: team ${holder.team} is active in this block on ${levelsLabel(holder.levels)}` : it.status === 'queued' ? 'Drag to reorder, onto another team to move it, or onto the list to take it off the plan' : it.status;
        const row = document.createElement('div');
        row.className = 'arow';
        row.append(Object.assign(document.createElement('b'), { className: 'aisle', textContent: it.aisle }));
        if (ov.zone) row.append(Object.assign(document.createElement('span'), { className: 'z', textContent: titleCase(ov.zone) }));
        row.append(Object.assign(document.createElement('span'), { className: 'lv', textContent: `${levelsLabel(it.levels)}${it.direction === 'down' ? ' · from the far end ↩' : ''}${blocked ? ' ⏳' : ''}` }));
        const state = it.status === 'active' ? 'Counting now' : it.status === 'done' ? 'Done' : blocked ? `Held · team ${holder.team}` : nextSeen ? 'Queued' : 'Next';
        if (it.status === 'queued') nextSeen = true;
        row.append(Object.assign(document.createElement('span'), { className: 'st', textContent: state }));
        a.appendChild(row);
        /* how far the aisle is: bins with a count, over the aisle's bins */
        if (it.status === 'active' && ov.bins) {
          const pct = Math.min(100, Math.round(100 * (ov.bins_counted || 0) / ov.bins));
          const bar = document.createElement('div'); bar.className = 'bar'; bar.innerHTML = '<i></i>'; bar.querySelector('i').style.width = pct + '%';
          a.appendChild(bar);
          a.appendChild(Object.assign(document.createElement('div'), { className: 'pm', textContent: `${(ov.bins_counted || 0).toLocaleString()} / ${ov.bins.toLocaleString()} bins have a count · ${pct}%${it.started_at ? ` · since ${new Date(it.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` }));
        } else if (it.status === 'done') {
          a.appendChild(Object.assign(document.createElement('div'), { className: 'pm', textContent: `${(ov.bins_counted || 0).toLocaleString()} of ${(ov.bins || 0).toLocaleString()} bins counted${it.completed_at ? ` · done ${new Date(it.completed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` }));
        } else if (blocked) {
          a.appendChild(Object.assign(document.createElement('div'), { className: 'pm', textContent: `waits for team ${holder.team} in ${holder.aisle === it.aisle ? 'this aisle' : `${holder.aisle}, which shares the racking`}` }));
        } else if (ov.bins) {
          a.appendChild(Object.assign(document.createElement('div'), { className: 'pm', textContent: `${ov.bins.toLocaleString()} bins${ov.bins_counted ? ` · ${ov.bins_counted.toLocaleString()} already counted` : ''}` }));
        }
        const acts = document.createElement('div');
        acts.className = 'acts';
        const act = (label, status) => {
          const b = document.createElement('button');
          b.className = 'sm ghost';
          b.textContent = label;
          b.disabled = !can;
          if (status === 'delete') b.title = it.status === 'queued' ? 'Take it off the plan' : `Take it off the plan - the aisle's counts stay${it.status === 'active' ? ', and the team\'s next aisle starts' : ''}`;
          if (status === 'queued' && it.status === 'active') b.title = 'Release it: back of the queue, and the next aisle starts';
          if (status === 'done') b.title = 'The aisle is finished: pallets nobody saw become second counts, the aisle is filed, and the team\'s next aisle starts';
          if (status === 'active' && blocked) b.title = 'Start it anyway - refused while the other team holds those levels';
          b.onclick = async () => {
            // an aisle being counted, or finished: a second look before it goes
            if (status === 'delete' && it.status !== 'queued' && !confirm(`Take ${it.aisle} off team ${team}'s plan? Its counts stay.`)) return;
            await planAct(() => (status === 'delete' ? apiJson(`/api/admin/sessions/${sessionId}/assignments/${it.id}`, { method: 'DELETE' })
              : postJson(`/api/admin/sessions/${sessionId}/assignments/${it.id}`, { status })), (out) => {
              const next = (out.activated || []).find((x) => x.team === team);
              if (out.note) msg($('assignMsg'), 'warn', out.note);
              else if (status === 'delete') msg($('assignMsg'), 'ok', `${it.aisle} is off team ${team}'s plan.`, next ? `${next.aisle} started in its place.` : '');
              else if (status === 'queued' && it.status === 'active') msg($('assignMsg'), 'ok', `${it.aisle} released to the back of team ${team}'s queue.`, next ? `${next.aisle} started.` : '');
              else if (status === 'done') msg($('assignMsg'), 'ok', `${it.aisle} is done for team ${team}.`, next ? `${next.aisle} started.` : '');
            });
          };
          return b;
        };
        if (it.status === 'queued') { acts.appendChild(act('start', 'active')); acts.appendChild(act('✕', 'delete')); }
        if (it.status === 'active') { acts.appendChild(act('done', 'done')); acts.appendChild(act('release', 'queued')); acts.appendChild(act('✕', 'delete')); }
        if (it.status === 'done') { acts.appendChild(act('reopen', 'queued')); acts.appendChild(act('✕', 'delete')); }
        a.appendChild(acts);
        /* a queued aisle can be dragged: up or down this queue, to another team, or back to the list */
        if (it.status === 'queued' && can) {
          a.draggable = true;
          a.addEventListener('dragstart', (e) => { Object.assign(drag, { kind: 'assignment', id: it.id, team, aisle: it.aisle }); e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'assignment', id: it.id, team })); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); });
          a.addEventListener('dragend', () => { for (const el of document.querySelectorAll('.a.before, .team.over, .pool.over')) el.classList.remove('before', 'over'); });
        }
        seq.appendChild(a);
      }
      box.appendChild(seq);
      if (!items.length) {
        /* a team with nothing queued: one tap fills the form for it, levels from what it reaches */
        const go = button('Queue aisles for this team', 'sm', () => {
          $('fAssignTeam').value = team;
          if (ct && ct.reach) $('fAssignLevels').value = levelsBox(ct.reach);
          $('fAssignAisles').focus();
        });
        go.dataset.queueFor = team;
        go.disabled = !can;
        box.appendChild(go);
      }
      if (can) box.appendChild(Object.assign(document.createElement('div'), { className: 'drop', textContent: items.length ? 'Drop an aisle here to queue it last' : 'Drop an aisle here' }));

      /* ---- dropping onto the column ---- */
      if (can) {
        box.addEventListener('dragover', (e) => {
          if (!drag.kind) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          box.classList.add('over');
          for (const el of box.querySelectorAll('.a.before')) el.classList.remove('before');
          const over = e.target.closest('.a.queued');
          if (over && drag.kind === 'assignment') over.classList.add('before');
        });
        box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) { box.classList.remove('over'); for (const el of box.querySelectorAll('.a.before')) el.classList.remove('before'); } });
        box.addEventListener('drop', async (e) => {
          e.preventDefault();
          box.classList.remove('over');
          const d = dragKind(e);
          const before = e.target.closest('.a.queued');
          for (const el of box.querySelectorAll('.a.before')) el.classList.remove('before');
          if (d.kind === 'aisle') { await queueDropped(team, d.aisle, ct && ct.reach); return; }
          if (d.kind !== 'assignment') return;
          // the team's queued aisles in their new order: the dragged one in front of the card it was dropped on, else last
          const ids = [...box.querySelectorAll('.a.queued')].map((el) => Number(el.dataset.id)).filter((n) => n !== Number(d.id));
          const at = before && Number(before.dataset.id) !== Number(d.id) ? ids.indexOf(Number(before.dataset.id)) : -1;
          if (at >= 0) ids.splice(at, 0, Number(d.id)); else ids.push(Number(d.id));
          await planAct(() => postJson(`/api/admin/sessions/${sessionId}/assignments/order`, { team, ids }), (out) => {
            const moved = out.moved.find((x) => x.id === Number(d.id));
            const started = (out.activated || []).find((x) => x.team === team);
            msg($('assignMsg'), 'ok', moved && moved.from !== team ? `${moved.aisle} moved from team ${moved.from} to team ${team}.` : `Team ${team}'s queue reordered.`, started ? `${started.aisle} started.` : '');
          });
        });
      }
      board.appendChild(box);
    }
  }
  /* the list takes a queued aisle back: off the plan */
  {
    const pool = $('aislePool');
    pool.addEventListener('dragover', (e) => { if (drag.kind === 'assignment') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; pool.classList.add('over'); } });
    pool.addEventListener('dragleave', (e) => { if (!pool.contains(e.relatedTarget)) pool.classList.remove('over'); });
    pool.addEventListener('drop', async (e) => {
      e.preventDefault(); pool.classList.remove('over');
      const d = dragKind(e);
      if (d.kind !== 'assignment') return;
      await planAct(() => apiJson(`/api/admin/sessions/${sessionId}/assignments/${d.id}`, { method: 'DELETE' }), (out) => {
        msg($('assignMsg'), 'ok', `${out.removed.aisle} is off team ${out.removed.team}'s plan.`, (out.activated || []).some((x) => x.team === out.removed.team) ? 'The team\'s next aisle started.' : '');
      });
    });
    $('poolFilter').addEventListener('input', () => refreshAssignments().catch(() => {}));
    $('btnPlanFileTools').onclick = () => { const r = $('planFileRow'); r.hidden = !r.hidden; $('btnPlanFileTools').classList.toggle('selected', !r.hidden); };
    $('btnPlanHelp').onclick = () => { const h = $('planHelp'); h.hidden = !h.hidden; };
  }

  /** The count being looked at, as the session list has it. */
  const currentSession = () => sessions.find((x) => x.id === sessionId) || null;
  /* A workbook from the server's sheets: { filename, sheets: [{ name, columns, rows }] }. */
  function writeWorkbook(XLSX, data) {
    const wb = XLSX.utils.book_new();
    for (const sh of data.sheets) {
      const ws = XLSX.utils.json_to_sheet(sh.rows, { header: sh.columns });
      // wide enough to read without dragging every column
      ws['!cols'] = sh.columns.map((c) => ({
        wch: Math.min(60, Math.max(String(c).length, ...sh.rows.slice(0, 500).map((r) => String(r[c] ?? '').length)) + 2),
      }));
      if (sh.rows.length && sh.name !== 'Summary') ws['!autofilter'] = { ref: ws['!ref'] };
      XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
    }
    XLSX.writeFile(wb, data.filename);
  }

  /* ------------------------------------------------------------ second counts */
  async function refreshRecounts() {
    const rows = await apiJson(`/api/admin/sessions/${sessionId}/recounts`);
    const thirdOn = !!(currentSession() && currentSession().third_count);
    /* where new second counts go, and who has the open ones - for the hand-over bar */
    const cur = currentSession();
    const rteam = cur && cur.recount_team_on && cur.recount_team ? cur.recount_team : '';
    $('recTeamChip').hidden = !rteam;
    $('recTeamChip').textContent = rteam ? `new second counts go to team ${rteam}` : '';
    $('recTeamChip').className = 'chip online';
    const byTeam = new Map();
    for (const r of rows) if (r.status === 'open' && r.reason !== 'CYCLE') byTeam.set(r.team || '', (byTeam.get(r.team || '') || 0) + 1);
    const fromSel = $('fMoveFrom');
    const was = fromSel.value;
    fromSel.replaceChildren(...[...byTeam].sort((a, b) => (b[0] === rteam) - (a[0] === rteam) || b[1] - a[1]).map(([t, n]) => {
      const o = document.createElement('option'); o.value = t; o.textContent = `${t ? 'team ' + t : 'any team'} — ${n} open`; return o;
    }));
    if ([...fromSel.options].some((o) => o.value === was)) fromSel.value = was;
    $('recMoveBar').hidden = !byTeam.size;
    const open = rows.filter((r) => r.status !== 'done').length;
    $('recountSub').textContent = rows.length ? `${open} open · ${rows.length - open} done` : '';
    api.subCount('second', open);   // so an open second count is visible from any tab
    table($('recountTable'),
      [{ label: 'Bin' }, { label: 'Pallet' }, { label: 'Reason' }, { label: 'Detail' }, { label: 'Source' }, { label: '1st team' },
       { label: 'Team' }, { label: 'Status' }, { label: '1st count' }, { label: '2nd count' }, ...(thirdOn || rows.some((x) => Number(x.round) === 3) ? [{ label: '3rd count' }] : []), { label: '' }],
      rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.dataset.recount = r.id;
        const third = Number(r.round) === 3;
        if (third) tr.classList.add('third');
        const reason = cell(third ? `3rd count · ${r.reason}` : r.reason);
        tr.append(cell(r.bin), cell(r.pallet_id || '—'), reason, cell(r.detail || '', 'wrap'), cell(r.source), cell(third && r.second_team ? `${r.first_team || '—'} · 2nd ${r.second_team}` : (r.first_team || '—')));
        const tdTeam = document.createElement('td');
        const inp = document.createElement('input'); inp.className = 'sm'; inp.style.width = '60px'; inp.value = r.team || ''; inp.placeholder = 'any';
        inp.title = 'Assign to a team and press Enter; blank = any team (except the first-count team)';
        inp.onkeydown = async (e) => { if (e.key !== 'Enter') return; try { await postJson(`/api/admin/sessions/${sessionId}/recounts/${r.id}`, { team: inp.value }); await refreshRecounts(); } catch (err) { msg($('recountMsg'), 'err', err.message); } };
        tdTeam.appendChild(inp); tr.appendChild(tdTeam);
        const tdSt = document.createElement('td'); tdSt.appendChild(tag(r.status)); tr.appendChild(tdSt);
        tr.append(cell(r.first_result || (r.first_lines ? '' : 'nothing'), 'wrap'), cell(r.second_result || '', 'wrap'));
        if (thirdOn || rows.some((x) => Number(x.round) === 3)) tr.append(cell(r.third_result || '', 'wrap'));
        const tdBtn = document.createElement('td');
        const act = (label, body, method = 'POST') => {
          const b = document.createElement('button'); b.className = 'sm ghost'; b.textContent = label; b.style.marginRight = '4px';
          b.onclick = async () => { try { await apiJson(`/api/admin/sessions/${sessionId}/recounts/${r.id}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); await refreshAll(); } catch (err) { msg($('recountMsg'), 'err', err.message); } };
          return b;
        };
        if (r.status !== 'done') tdBtn.appendChild(act('done', { status: 'done' }));
        else tdBtn.appendChild(act('reopen', { status: 'open' }));
        /* a finished second count that has not settled things: a third, by a team that did neither */
        if (r.status === 'done' && !third && r.reason !== 'CYCLE' && !r.third_id) {
          const b = document.createElement('button'); b.className = 'sm'; b.textContent = '3rd count'; b.style.marginRight = '4px';
          b.dataset.third = r.id;
          b.title = 'Count this bin a third time, by a team that did neither the first nor the second count';
          b.onclick = async () => {
            try {
              const out = await postJson(`/api/admin/sessions/${sessionId}/recounts/${r.id}/third`, {});
              msg($('recountMsg'), out.created ? 'ok' : 'warn', out.created ? `Third count raised for ${out.bin}.` : `${out.bin} already has an open count.`, out.created ? `${out.why[0].toUpperCase()}${out.why.slice(1)}.` : '');
              await refreshAll();
            } catch (err) { msg($('recountMsg'), 'err', err.message); }
          };
          tdBtn.appendChild(b);
        }
        tdBtn.appendChild(act('✕', null, 'DELETE'));
        tr.appendChild(tdBtn);
        return tr;
      }, 'No second counts yet.');
  }

  $('btnMove').onclick = async () => {
    if (!needSession($('recountMsg'))) return;
    const from = $('fMoveFrom').value;
    const to = $('fMoveTo').value.trim();
    if (norm(from) === norm(to)) return msg($('recountMsg'), 'warn', `They are with ${to ? 'team ' + to : 'any team'} already.`);
    try {
      const out = await postJson(`/api/admin/sessions/${sessionId}/recounts/reassign`, { from, to, limit: $('fMoveHow').value || 0, aisle: $('fMoveAisle').value });
      msg($('recountMsg'), out.moved ? 'ok' : 'warn',
        `${out.moved} second count${out.moved === 1 ? '' : 's'} handed from ${out.from ? 'team ' + out.from : 'any team'} to ${out.to ? 'team ' + out.to : 'any team'}.`,
        [out.skipped.length ? `${out.skipped.length} stayed: team ${out.to} counted ${out.skipped.length === 1 ? 'that bin' : 'those bins'} itself (${out.skipped.slice(0, 4).join(', ')}${out.skipped.length > 4 ? '…' : ''}).` : '',
          out.taken ? `${out.taken} already started stay with team ${out.from}.` : '', out.left ? `${out.left} more still with ${out.from ? 'team ' + out.from : 'any team'}.` : ''].filter(Boolean).join(' '));
      $('fMoveHow').value = '';
      await refreshAll();
    } catch (err) { msg($('recountMsg'), 'err', err.message); }
  };
  $('btnRecAdd').onclick = async () => {
    if (!needSession($('recountMsg'))) return;
    try {
      const r = await postJson(`/api/admin/sessions/${sessionId}/recounts`, { bin: $('fRecBin').value, palletId: $('fRecPallet').value, note: $('fRecNote').value, team: $('fRecTeam').value });
      msg($('recountMsg'), r.created ? 'ok' : 'warn', r.created ? 'Second count requested.' : 'That bin already has an open second count.');
      $('fRecBin').value = ''; $('fRecPallet').value = ''; $('fRecNote').value = '';
      await refreshAll();
    } catch (err) { msg($('recountMsg'), 'err', err.message); }
  };
  $('btnRecGenerate').onclick = async () => {
    if (!needSession($('recountMsg'))) return;
    try {
      const r = await postJson(`/api/admin/sessions/${sessionId}/recounts/generate`, {});
      const skipped = [];
      if (r.skippedUnworked) skipped.push(`${r.skippedUnworked.toLocaleString()} pallet(s) in aisles nobody has counted yet — not missing, just not reached`);
      if (r.skippedSmall) skipped.push(`${r.skippedSmall.toLocaleString()} under the recount threshold`);
      if (r.cappedAt) skipped.push(`stopped at the cap of ${r.cappedAt} open`);
      msg($('recountMsg'), 'ok', `Raised ${r.created} second count(s) from ${r.considered} pallet(s) that disagree with the report.`,
        skipped.length ? 'Left alone: ' + skipped.join(' · ') + '.' : '');
      await refreshAll();
    } catch (err) { msg($('recountMsg'), 'err', err.message); }
  };
  $('btnExportRecounts').onclick = () => download(`/api/admin/sessions/${sessionId}/export/recounts.csv`, `second-counts-session-${sessionId}.csv`);
  /* every bin counted again: the first, second and third counts beside the report, one aisle or all */
  $('btnExportSideBySide').onclick = async () => {
    if (!needSession($('recountMsg'))) return;
    const b = $('btnExportSideBySide'); const was = b.textContent;
    b.disabled = true; b.textContent = 'Building…';
    try {
      const aisle = $('fRecAisle').value;
      const [data, XLSX] = await Promise.all([apiJson(`/api/admin/sessions/${sessionId}/export/recounts-side-by-side${aisle ? `?aisle=${encodeURIComponent(aisle)}` : ''}`), window.appUi.loadXlsx()]);
      writeWorkbook(XLSX, data);
      msg($('recountMsg'), 'ok', `Exported ${data.tally.bins} bin${data.tally.bins === 1 ? '' : 's'} counted again${aisle ? ` in ${aisle}` : ''}`, data.filename);
    } catch (err) { msg($('recountMsg'), 'err', 'Could not build the export', err.message); }
    finally { b.disabled = false; b.textContent = was; }
  };

  /* ------------------------------------------------ ERP, printing, housekeeping */
  $('btnPrint').onclick = () => {
    if (!needSession($('printMsg'))) return;
    const q = new URLSearchParams();
    if ($('fPrintAisle').value.trim()) q.set('aisle', $('fPrintAisle').value.trim());
    if ($('fPrintLevels').value.trim()) q.set('levels', $('fPrintLevels').value.trim());
    if ($('fPrintUncounted').checked) q.set('uncounted', '1');
    if ($('fPrintExpected').checked) q.set('blind', '0');
    // the sheet is a page, not a download, so it needs the token in the URL
    q.set('t', api.token);
    window.open(`/api/admin/sessions/${sessionId}/print/count-sheet?${q}`, '_blank');
  };

  /* ------------------------------------------------------------ pallet report */
  /* The whole report comes down once; the filters work on it here, at once,
     so a supervisor reads the list they want without exporting it. */
  let palletRows = [];
  const lotTrouble = (r) => (r.lot_status && r.lot_status !== 'LOT MATCH') || r.expiry_status === 'EXPIRED' || r.expiry_status === 'EXPIRES SOON';
  async function refreshPallets() {
    const src = sourceParam('fPalletSource');
    const srcQ = src == null ? '' : `&source=${encodeURIComponent(src)}`;
    palletRows = (await apiJson(`/api/admin/sessions/${sessionId}/pallets?limit=100000${srcQ}`)).rows;
    renderPallets();
  }
  function palletFilters() {
    return {
      hideMatch: $('fOnlyExceptions').checked, hideMissing: $('fHideMissing').checked, status: $('fPalletStatus').value,
      lotExp: $('fLotExpOnly').checked, bin: $('fPalletBin').value.trim().toUpperCase(), team: $('fPalletTeam').value.trim(),
      find: $('fPalletFind').value.trim().toLowerCase(),
    };
  }
  function renderPallets() {
    const f = palletFilters();
    const rows = palletRows.filter((r) => {
      if (f.hideMatch && r.status === 'MATCH' && !lotTrouble(r)) return false;
      if (f.hideMissing && (r.status === 'MISSING' || r.status === 'NOT COUNTED')) return false;
      if (f.status && r.status !== f.status) return false;
      if (f.lotExp && !lotTrouble(r)) return false;
      if (f.bin && !(String(r.expected_location || '').toUpperCase().startsWith(f.bin) || String(r.found_location || '').toUpperCase().includes(f.bin))) return false;
      if (f.team && !String(r.teams || '').split(/[,\s]+/).includes(f.team)) return false;
      if (f.find && !`${r.pallet_id} ${r.sku || ''} ${r.description || ''}`.toLowerCase().includes(f.find)) return false;
      return true;
    });
    // a cap on the rows shown, so the report is read, not scrolled; the CSV has all of it
    const lim = $('fPalletLimit').value;
    const data = { total: rows.length, rows: rows.slice(0, lim === 'all' ? rows.length : Number(lim)), all: palletRows.length };
    /* The columns inventory control reads, in the order they read them, sized to
       the page: long text wraps, the Recount button sits under the status, and a
       found-in bin is shown only when it is not the bin the report expected. */
    // long text: two lines in the cell, all of it on hover - the clamp is on a box inside, a cell stays a cell
    const clampCell = (text) => { const td = document.createElement('td'); td.className = 'wrap'; const d = document.createElement('div'); d.className = 'clamp'; d.textContent = text || ''; td.title = text || ''; td.appendChild(d); return td; };
    const when = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    table($('palletTable'),
      [{ label: 'Pallet ID' }, { label: 'System' }, { label: 'SKU' }, { label: 'Description' }, { label: 'Expected', num: true }, { label: '1st count', num: true }, { label: '2nd count', num: true }, { label: 'Counted', num: true },
       { label: 'Expected bin' }, { label: 'Found in' }, { label: 'Lot' }, { label: 'Expiry' }, { label: 'Team' }, { label: 'Comments' }, { label: 'Status' }, { label: 'ERP upload' }],
      data.rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.dataset.pallet = r.pallet_id;
        /* a pallet wearing two labels: say which tag belongs to which pallet,
           so nobody reads the second one as stock that is missing */
        const tdPallet = document.createElement('td');
        tdPallet.className = 'pid';
        tdPallet.append(r.pallet_id);
        if (r.alias_of) {
          const t = tag('SECOND LABEL');
          t.textContent = `2nd label of ${r.alias_of}`;
          tdPallet.append(document.createElement('br'), t);
        } else if (r.also_tagged) {
          const t = tag('SECOND LABEL');
          t.textContent = `also tagged ${r.also_tagged}`;
          tdPallet.append(document.createElement('br'), t);
        }
        // the found-in bin only when it differs: a column of the same bin twice says nothing
        const found = r.found_location && r.found_location !== r.expected_location ? r.found_location : '';
        const tdDesc = clampCell(r.description);
        tr.append(tdPallet, cell(r.source || '—'), cell(r.sku), tdDesc, cell(r.expected_qty, 'num'),
          cell(r.recounted ? r.first_count_qty : '', 'num'), cell(r.recounted ? r.second_pass_qty : '', 'num'), cell(r.counted_qty, 'num strong'),
          cell(r.expected_location), cell(found, found ? 'diff' : ''));
        // lot and expiry are blank unless the site tracks them, so they cost nothing when it does not
        const tdLot = document.createElement('td');
        if (r.found_lot || r.expected_lot) {
          tdLot.append(r.found_lot || r.expected_lot);
          if (r.lot_status && r.lot_status !== 'LOT MATCH') {
            const t = tag(r.lot_status === 'WRONG LOT' ? 'MISSING' : 'queued');
            t.textContent = r.lot_status === 'WRONG LOT' ? 'wrong lot' : r.lot_status === 'NO LOT SCANNED' ? 'not scanned' : 'not on report';
            t.title = r.expected_lot ? `The report says lot ${r.expected_lot}` : 'No lot for this pallet on the report';
            tdLot.append(document.createElement('br'), t);
          }
        }
        tr.appendChild(tdLot);
        const tdExp = document.createElement('td');
        if (r.expiry) {
          tdExp.append(r.expiry);
          if (r.expiry_status && r.expiry_status !== 'IN DATE') {
            const t = tag(r.expiry_status === 'EXPIRED' ? 'MISSING' : 'queued');
            t.textContent = r.expiry_status === 'EXPIRED' ? 'expired' : 'soon';
            tdExp.append(document.createElement('br'), t);
          }
        }
        tr.appendChild(tdExp);
        const tdCom = clampCell(r.comments);
        tr.append(cell(r.teams), tdCom);
        // the status, with the Recount button under it rather than a column of its own
        const td = document.createElement('td');
        td.className = 'st';
        td.appendChild(tag(r.status));
        if (r.recounted) { const t2 = tag('MATCH'); t2.textContent = Number(r.count_round) === 3 ? '3rd count' : '2nd count'; td.append(document.createElement('br'), t2); }
        if (r.status !== 'MATCH' && r.status !== 'SECOND LABEL' && !r.open_recounts) {
          const b = document.createElement('button'); b.className = 'sm ghost'; b.textContent = 'Recount';
          b.onclick = async () => { try { await postJson(`/api/admin/sessions/${sessionId}/recounts`, { palletId: r.pallet_id, note: `from pallet report: ${r.status}` }); await refreshAll(); } catch (err) { alert(err.message); } };
          td.append(document.createElement('br'), b);
        } else if (r.open_recounts) td.append(document.createElement('br'), Object.assign(document.createElement('span'), { className: 'muted', textContent: 'recount pending' }));
        tr.appendChild(td);
        /* uploaded to the ERP: by whom and when, or not yet - and a line that has
           moved since it went in, so it is keyed again. A match has nothing to upload. */
        const tdErp = document.createElement('td');
        tdErp.className = 'erp';
        if (r.erp_uploaded) {
          tdErp.appendChild(tag(r.erp_changed ? 'queued' : 'ok', r.erp_changed ? 'changed since' : '✓ uploaded'));
          tdErp.append(document.createElement('br'), Object.assign(document.createElement('span'), { className: 'muted', textContent: [r.erp_by, when(r.erp_at)].filter(Boolean).join(' · ') }));
        } else if (r.status === 'MATCH' || r.status === 'SECOND LABEL' || r.status === 'NOT COUNTED') {
          tdErp.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: '—' }));
          tdErp.title = r.status === 'NOT COUNTED' ? 'Not counted yet' : 'Nothing to upload: it matches the report';
        } else {
          tdErp.appendChild(tag('off', 'not yet'));
        }
        tr.appendChild(tdErp);
        return tr;
      }, 'No pallets to show.');
    $('palletNote').textContent = (data.total > data.rows.length
      ? `Showing ${data.rows.length} of ${data.total} that match — set Show to All, or export the CSV for the full list.` : `${data.total} row(s) match`)
      + (data.total !== data.all ? ` · ${data.all.toLocaleString()} on the report in all` : '');
  }

  /* ------------------------------------------------------------ warehouse map */
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // Same rules as src/util/bincode.js: "A03-12-1" -> bay 12, "F01A001" -> bay 001.
  function parseBinCode(raw) {
    const code = String(raw || '').trim().toUpperCase();
    const parts = code.split(/[-_./\\ ]/).filter(Boolean);
    if (parts.length >= 2) return { aisle: parts[0], bay: parts[1], level: parts[2] || '' };
    const m = /^([A-Z]+\d+)([A-Z])(\d+)$/.exec(code);
    if (m) return { aisle: m[1], level: m[2], bay: m[3] };
    const a = /^([A-Z]+)(\d*)$/.exec(code);
    if (a) return { aisle: a[1], bay: a[2] || code, level: '' };
    return { aisle: code, bay: code, level: '' };
  }
  const bayOf = (code) => parseBinCode(code).bay;
  const aisleNumber = (aisle) => { const m = /(\d+)\s*$/.exec(String(aisle || '')); return m ? String(Number(m[1])) : String(aisle || '').toUpperCase(); };

  const CELL_FILL = (frac) => (frac === 0 ? '#8b949e' : frac < 1 ? '#d29922' : '#2ea043');

  // bins -> aisle -> bay -> {bins, counted, flagged, faces?}
  // With `slotsPerBay` (from the layout) positions are grouped into physical
  // bays and split by face: odd positions are Front, even are Back (double-deep).
  const emptyCell = () => ({ bins: [], counted: 0, flagged: 0 });
  function groupBays(bins, specFor = () => null) {
    const byAisle = new Map();
    for (const [code, aisle, lines, flagged] of bins) {
      if (!byAisle.has(aisle)) byAisle.set(aisle, new Map());
      const bays = byAisle.get(aisle);
      const spec = specFor(aisle);
      const rawBay = bayOf(code);
      const pos = Number(rawBay);
      const grouped = spec && spec.slotsPerBay && Number.isFinite(pos);
      const bay = grouped ? String(Math.ceil(pos / spec.slotsPerBay)) : rawBay;
      if (!bays.has(bay)) bays.set(bay, { ...emptyCell(), faces: grouped ? { front: emptyCell(), back: emptyCell() } : null });
      const b = bays.get(bay);
      const targets = [b];
      if (b.faces) targets.push(pos % 2 === 1 ? b.faces.front : b.faces.back);
      for (const t of targets) { t.bins.push({ code, counted: lines > 0, flagged: flagged > 0 }); if (lines > 0) t.counted++; if (flagged > 0) t.flagged++; }
    }
    return byAisle;
  }

  // Hover text for a cell, in the terms people use on the floor: the aisle, the
  // face, the position numbers and levels in the cell, then which bins are done.
  function cellTitle(aisle, bay, b, face) {
    const parsed = b.bins.map((x) => ({ ...x, ...parseBinCode(x.code) }));
    const positions = [...new Set(parsed.map((x) => x.bay))].sort(natural);
    const levels = [...new Set(parsed.map((x) => x.level).filter(Boolean))].sort();
    const lv = levels.length > 1 ? `levels ${levels[0]}–${levels[levels.length - 1]}` : levels.length ? `level ${levels[0]}` : '';
    const list = (arr) => (arr.length > 14 ? arr.slice(0, 14).join(', ') + ` … +${arr.length - 14}` : arr.join(', ')) || '—';
    const done = parsed.filter((x) => x.counted).map((x) => x.code).sort(natural);
    const open = parsed.filter((x) => !x.counted).map((x) => x.code).sort(natural);
    return [
      `${aisleLabel(aisle, zoneByAisle.get(aisle))} · Bay ${bay}${face ? ` · ${face === 'front' ? 'FRONT' : 'BACK'}` : ''}${lv ? ' · ' + lv : ''}`,
      `Position${positions.length > 1 ? 's' : ''} ${positions.join(', ')}`,
      `${b.counted} of ${b.bins.length} counted${b.flagged ? ` · ${b.flagged} flagged` : ''}`,
      `Counted: ${list(done)}`,
      `Still to count: ${list(open)}`,
    ].join('\n');
  }

  /** Heat map drawn over a floor-plan drawing: each aisle has pixel boxes in the layout file. */
  function renderBlueprint(svg, data, layout) {
    svg.classList.add('blueprint');
    const W = layout.width, H = layout.height;
    // The drawing runs to its own edge, so labels drawn over it fight the print.
    // Give them a gutter of their own to the left instead.
    svg.setAttribute('viewBox', `${-GUTTER} 0 ${W + GUTTER} ${H}`);
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.appendChild(svgEl('image', { href: layout.image, x: 0, y: 0, width: W, height: H, opacity: 0.7 }));

    // layout key -> session aisle: exact code first ("F01"), then by number when unambiguous
    const exact = new Map(data.aisles.map((a) => [a.aisle, a]));
    const byNumber = new Map();
    for (const a of data.aisles) { const n = aisleNumber(a.aisle); byNumber.set(n, byNumber.has(n) ? null : a); }
    const resolve = (key) => exact.get(String(key).toUpperCase()) || byNumber.get(String(key)) || null;
    const specOf = new Map();
    for (const [key, spec] of Object.entries(layout.aisles)) { const a = resolve(key); if (a) specOf.set(a.aisle, spec); }

    const byAisle = groupBays(data.bins, (aisle) => specOf.get(aisle));
    const placed = new Set();
    let counted = 0, total = 0;

    for (const [key, spec] of Object.entries(layout.aisles)) {
      const a = resolve(key);
      const bays = a ? byAisle.get(a.aisle) : null;
      const segs = spec.segments;
      if (!a || !bays) {
        for (const [x, y, w, h] of segs) svg.appendChild(svgEl('rect', { x, y, width: w, height: h, fill: 'none', stroke: '#8b949e', 'stroke-dasharray': '4 3', opacity: 0.6 }));
        continue;
      }
      placed.add(a.aisle);
      const keys = [...bays.keys()].sort(natural);
      if (spec.reverse) keys.reverse();
      const horizontal = spec.dir !== 'v';
      const lengths = segs.map(([, , w, h]) => (horizontal ? w : h));
      const totalLen = lengths.reduce((s, v) => s + v, 0);
      let bi = 0;
      segs.forEach(([x, y, w, h], si) => {
        const n = si === segs.length - 1 ? keys.length - bi : Math.round((lengths[si] / totalLen) * keys.length);
        const size = n ? lengths[si] / n : 0;
        for (let k = 0; k < n; k++, bi++) {
          const bay = keys[bi];
          const b = bays.get(bay);
          total += b.bins.length; counted += b.counted;
          const box = horizontal
            ? { x: x + k * size + 0.5, y: y + 1, w: Math.max(1, size - 1), h: h - 2 }
            : { x: x + 1, y: y + k * size + 0.5, w: w - 2, h: Math.max(1, size - 1) };
          // a double-deep bay is two cells across the depth: the Front face on the aisle side
          const parts = b.faces
            ? (() => {
                const frontFirst = spec.front === 'top' || spec.front === 'left';
                const [p1, p2] = frontFirst ? [b.faces.front, b.faces.back] : [b.faces.back, b.faces.front];
                const [f1, f2] = frontFirst ? ['front', 'back'] : ['back', 'front'];
                return horizontal
                  ? [[p1, f1, { ...box, h: box.h / 2 - 0.5 }], [p2, f2, { ...box, y: box.y + box.h / 2 + 0.5, h: box.h / 2 - 0.5 }]]
                  : [[p1, f1, { ...box, w: box.w / 2 - 0.5 }], [p2, f2, { ...box, x: box.x + box.w / 2 + 0.5, w: box.w / 2 - 0.5 }]];
              })()
            : [[b, '', box]];
          for (const [cell, face, r] of parts) {
            if (!cell.bins.length) continue;
            const frac = cell.counted / cell.bins.length;
            const el = svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: CELL_FILL(frac), class: 'cell', opacity: 0.9,
              stroke: cell.flagged ? '#f85149' : 'none', 'stroke-width': cell.flagged ? 1.5 : 0 });
            const t = svgEl('title'); t.textContent = cellTitle(a.aisle, bay, cell, face); el.appendChild(t);
            svg.appendChild(el);
          }
        }
      });
      drawAisleFurniture(svg, a, spec, segs, horizontal);
    }
    // Areas with no place on the drawing (doors, staging, ...) are summarized, not lost.
    const missing = [...byAisle.entries()].filter(([k]) => !placed.has(k)).map(([k, bays]) => {
      let c = 0, t = 0; for (const b of bays.values()) { c += b.counted; t += b.bins.length; }
      counted += c; total += t;
      return `${k} ${c}/${t}`;
    });
    return { counted, total, missing };
  }


  /* --------------------------------------------------- aisle rings and labels
     A ring round each aisle says at a glance what state it is in, before you
     read a single cell: green done, blue a team is in it, amber part-counted,
     gray untouched. The label carries the zone, the code and the percentage,
     and the whole thing is clickable. */
  const RING = {
    done:    { stroke: '#2ea043', label: 'complete' },
    active:  { stroke: '#2f81f7', label: 'team counting' },
    partial: { stroke: '#d29922', label: 'part counted' },
    queued:  { stroke: '#8957e5', label: 'queued to a team' },
    idle:    { stroke: '#8b949e', label: 'not started' },
  };
  /* The ring color is right for a 2px line on a pale drawing and too dark for
     8px type: the aisle codes of every untouched aisle were unreadable. Text
     gets a lighter shade of the same idea. */
  const RING_TEXT = { done: '#7ee2a0', active: '#79b8ff', partial: '#f2c057', queued: '#c0a6ff', idle: '#cdd9e5' };
  const ringState = (a) => (a.done ? 'done' : a.activeTeam ? 'active'
    : a.counted > 0 ? 'partial' : a.queuedTeams ? 'queued' : 'idle');
  const GUTTER = 46;   // room to the left of the drawing for the aisle labels
  const zoneShort = (z) => (/dry/i.test(z) ? 'Dry' : /freez/i.test(z) ? 'Frz' : titleCase(z).slice(0, 4));

  let selectedAisle = '';

  function drawAisleFurniture(svg, a, spec, segs, horizontal) {
    const state = ringState(a);
    const ring = RING[state];
    const pct = a.bins ? Math.round((a.counted / a.bins) * 100) : 0;
    const g = svgEl('g', { class: 'aisle-g', 'data-aisle': a.aisle });

    // the ring: one rounded outline per segment, so a split aisle reads as one run
    for (const [x, y, w, h] of segs) {
      g.appendChild(svgEl('rect', {
        x: x - 1.5, y: y - 1.5, width: w + 3, height: h + 3, rx: 4,
        fill: 'none', stroke: ring.stroke, 'stroke-width': 2,
        class: 'ring', opacity: state === 'idle' ? 0.55 : 0.95,
      }));
    }
    // a soft fill behind the ring marks the selected aisle without hiding the drawing
    for (const [x, y, w, h] of segs) {
      g.appendChild(svgEl('rect', {
        x: x - 1.5, y: y - 1.5, width: w + 3, height: h + 3, rx: 4,
        fill: ring.stroke, opacity: 0, class: 'ring-fill',
      }));
    }

    const [x, y, w, h] = segs[0];

    /* The label block: aisle code, then zone and percentage under it. Horizontal
       aisles get the left gutter; vertical ones sit above their own head, where
       there is room. A pill behind it keeps it readable over the print. */
    // Vertical aisles stand side by side, so their labels are narrower and every
    // other one is lifted, or A01..A04 would sit on top of each other.
    const pw = horizontal ? GUTTER - 4 : 34;
    const lift = horizontal ? 0 : (aisleNumber(a.aisle) % 2 ? 0 : 22);
    const cx = horizontal ? -GUTTER + 4 : x + w / 2;
    const cy = (horizontal ? y + h / 2 : y - 20) - lift;
    const anchor = horizontal ? 'start' : 'middle';
    const pill = svgEl('rect', {
      x: horizontal ? -GUTTER + 1 : cx - pw / 2, y: cy - 10, width: pw, height: 21, rx: 4,
      fill: '#0b0e14', opacity: 0.82, stroke: ring.stroke, 'stroke-width': 1, class: 'label-pill',
    });
    g.appendChild(pill);
    const code = svgEl('text', { x: cx, y: cy + 0.5, 'text-anchor': anchor, class: 'aisle-label' });
    code.textContent = a.aisle;
    g.appendChild(code);
    const sub = svgEl('text', { x: cx, y: cy + 8.5, 'text-anchor': anchor, class: 'aisle-sub', fill: RING_TEXT[state] || '#cdd9e5' });
    sub.textContent = a.bins ? `${a.zone ? zoneShort(a.zone) + ' · ' : ''}${pct}%` : (a.zone ? zoneShort(a.zone) : '');
    g.appendChild(sub);

    // the badge: who is in it, or a tick when it is handed back
    if (a.activeTeam || a.done || a.queuedTeams) {
      const teams = a.activeTeam ? String(a.activeTeam).split(',').map((t) => 'T' + t.trim()).join('+')
        : a.done ? '✓' : String(a.queuedTeams).split(',').map((t) => 'T' + t.trim().split(' ')[0]).join('+');
      const bw = Math.max(20, teams.length * 7 + 8), bh = 14;
      const bx = horizontal ? x + 3 : x + w / 2 - bw / 2;
      const by = horizontal ? y + h / 2 - bh / 2 : y + 3;
      g.appendChild(svgEl('rect', {
        x: bx, y: by, width: bw, height: bh, rx: 7,
        fill: a.activeTeam ? '#2f81f7' : a.done ? '#2ea043' : '#30363d',
        stroke: a.queuedTeams && !a.activeTeam && !a.done ? '#8957e5' : 'none', 'stroke-width': 1,
      }));
      const t = svgEl('text', { x: bx + bw / 2, y: by + bh - 3.5, 'text-anchor': 'middle', class: 'team' });
      t.textContent = teams;
      g.appendChild(t);
    }

    const tip = svgEl('title');
    tip.textContent = `${aisleLabel(a.aisle, a.zone)} — ${ring.label}\n`
      + `${a.counted.toLocaleString()} of ${a.bins.toLocaleString()} bins counted (${pct}%)\n`
      + (a.activeTeam ? `Team ${a.activeDetail} counting now\n` : '')
      + (a.queuedTeams ? `Queued: team ${a.queuedTeams}\n` : '')
      + 'Click for the detail';
    g.appendChild(tip);
    g.addEventListener('click', () => selectAisle(a.aisle === selectedAisle ? '' : a.aisle));
    svg.appendChild(g);
  }

  /** Clicking an aisle opens the panel under the map and rings it heavily. */
  function selectAisle(aisle) {
    selectedAisle = aisle;
    for (const g of document.querySelectorAll('#map .aisle-g')) {
      const on = !!aisle && g.dataset.aisle === aisle;
      g.classList.toggle('selected', on);
      for (const f of g.querySelectorAll('.ring-fill')) f.setAttribute('opacity', on ? 0.18 : 0);
      for (const r of g.querySelectorAll('.ring')) r.setAttribute('stroke-width', on ? 4 : 2);
    }
    renderAislePanel();
  }

  function renderAislePanel() {
    const box = $('mapPanel');
    if (!selectedAisle) { box.hidden = true; return; }
    const a = (lastMap.aisles || []).find((x) => x.aisle === selectedAisle);
    if (!a) { box.hidden = true; return; }
    box.hidden = false;
    const pct = a.bins ? Math.round((a.counted / a.bins) * 100) : 0;
    const state = ringState(a);

    $('mapPanelTitle').textContent = aisleLabel(a.aisle, a.zone);
    const chip = $('mapPanelState');
    chip.textContent = RING[state].label;
    chip.style.color = RING[state].stroke;
    chip.style.borderColor = RING[state].stroke;

    $('mapPanelBar').style.width = pct + '%';
    $('mapPanelBar').style.background = RING[state].stroke;
    $('mapPanelPct').textContent = `${a.counted.toLocaleString()} of ${a.bins.toLocaleString()} bins · ${pct}%`;

    // per level, from the bins the map already has
    const levels = new Map();
    for (const [code, ais, lines] of lastMap.bins) {
      if (ais !== a.aisle) continue;
      const lv = parseBinCode(code).level || '—';
      const row = levels.get(lv) || { total: 0, counted: 0 };
      row.total += 1;
      if (lines > 0) row.counted += 1;
      levels.set(lv, row);
    }
    table($('mapPanelLevels'),
      [{ label: 'Level' }, { label: 'Bins', num: true }, { label: 'Counted', num: true }, { label: '' }],
      [...levels.entries()].sort((x, y) => natural(x[0], y[0])),
      ([lv, r]) => {
        const tr = document.createElement('tr');
        tr.append(cell(lv), cell(r.total, 'num'), cell(r.counted, 'num'));
        const td = document.createElement('td');
        const bar = document.createElement('div'); bar.className = 'bar';
        const i = document.createElement('i'); i.style.width = (r.total ? Math.round((r.counted / r.total) * 100) : 0) + '%';
        bar.appendChild(i); td.appendChild(bar); tr.appendChild(td);
        return tr;
      }, 'No bins in this aisle.');

    const who = [];
    if (a.activeTeam) who.push(`Team ${a.activeDetail} is counting it now.`);
    if (a.queuedTeams) who.push(`Queued for team ${a.queuedTeams}.`);
    if (a.done) who.push('Handed back as complete.');
    if (!who.length) who.push('No team has been queued onto this aisle yet.');
    who.push(`Racking block ${a.block || a.aisle} — only one team works a block at a time.`);
    $('mapPanelWho').textContent = who.join(' ');

    $('mapPanelSheet').onclick = () => {
      const q = new URLSearchParams({ aisle: a.aisle, t: api.token });
      window.open(`/api/admin/sessions/${sessionId}/print/count-sheet?${q}`, '_blank');
    };
    $('mapPanelQueue').onclick = () => {
      api.showSub('teams');
      $('fAssignAisles').value = a.aisle;
      $('fAssignTeam').focus();
    };
  }
  $('mapPanelClose').onclick = () => selectAisle('');
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selectedAisle) selectAisle(''); });

  /** Fallback when no drawing is chosen: aisles as columns, blocks touching. */
  function renderSchematic(svg, data) {
    svg.classList.remove('blueprint');
    const byAisle = groupBays(data.bins);
    const blocks = new Map();
    for (const a of data.aisles.sort((x, y) => natural(x.block, y.block) || natural(x.aisle, y.aisle))) {
      if (!blocks.has(a.block)) blocks.set(a.block, []);
      blocks.get(a.block).push(a);
    }
    for (const aisle of byAisle.keys()) if (!data.aisles.some((a) => a.aisle === aisle)) blocks.set(aisle, [{ aisle, block: aisle }]);

    const CW = 34, CH = 22, GAP = 3, WALK = 28, TOP = 46, LEFT = 10;
    let x = LEFT, maxBays = 0;
    const cells = [];
    for (const aisles of blocks.values()) {
      for (const a of aisles) {
        const bays = byAisle.get(a.aisle) || new Map();
        const keys = [...bays.keys()].sort(natural);
        maxBays = Math.max(maxBays, keys.length);
        cells.push({ a, x, keys, bays });
        x += CW + GAP;
      }
      x += WALK;
    }
    const width = x + LEFT, height = TOP + maxBays * (CH + GAP) + 12;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width); svg.setAttribute('height', height);

    let counted = 0, total = 0;
    for (const { a, x: cx, keys, bays } of cells) {
      const colH = maxBays * (CH + GAP);
      svg.appendChild(svgEl('rect', { x: cx - 1, y: TOP - 1, width: CW + 2, height: colH + 2, rx: 4,
        fill: a.activeTeam ? '#1f4d8f' : a.done ? '#10281a' : '#161b22', opacity: a.activeTeam ? 0.55 : 1 }));
      const label = svgEl('text', { x: cx + CW / 2, y: 14, 'text-anchor': 'middle', class: 'aisle-label' });
      label.textContent = a.aisle; svg.appendChild(label);
      if (a.activeTeam || a.done || a.queuedTeams) {
        svg.appendChild(svgEl('rect', { x: cx + 2, y: 20, width: CW - 4, height: 16, rx: 8, fill: a.activeTeam ? '#2f81f7' : a.done ? '#2ea043' : '#30363d' }));
        const t = svgEl('text', { x: cx + CW / 2, y: 32, 'text-anchor': 'middle', class: 'team' });
        t.textContent = a.activeTeam ? String(a.activeTeam).split(',').map((t) => 'T' + t.trim()).join('+') : a.done ? '✓' : 'T' + String(a.queuedTeams).split(',')[0].trim().replace(/ .*/, '');
        svg.appendChild(t);
      }
      keys.forEach((bay, i) => {
        const b = bays.get(bay);
        total += b.bins.length; counted += b.counted;
        const frac = b.bins.length ? b.counted / b.bins.length : 0;
        const y = TOP + i * (CH + GAP);
        const r = svgEl('rect', { x: cx + 2, y, width: CW - 4, height: CH, rx: 3, fill: CELL_FILL(frac), class: 'cell',
          stroke: b.flagged ? '#f85149' : 'none', 'stroke-width': b.flagged ? 2 : 0 });
        const t = svgEl('title'); t.textContent = cellTitle(a.aisle, bay, b); r.appendChild(t); svg.appendChild(r);
        const bl = svgEl('text', { x: cx + CW / 2, y: y + CH / 2 + 3, 'text-anchor': 'middle', class: 'bay-label', style: frac > 0 ? 'fill:#0d1117;font-weight:700' : '' });
        bl.textContent = bay; svg.appendChild(bl);
      });
    }
    return { counted, total, missing: [] };
  }

  let mapLevel = '';
  let layouts = [];

  /** Offer the drawing when a session is on the schematic and a drawing exists. */
  function showMapFix(noDrawing, hasBins) {
    $('mapFix').hidden = !(noDrawing && hasBins);
    if ($('mapFix').hidden) return;
    $('btnUseDrawing').textContent = `Use ${layouts[0].name}`;
    $('mapFixWhy').textContent = 'This session is on the schematic. Switch it to the rack drawing to see the real floor plan.';
  }
  $('btnUseDrawing').onclick = async () => {
    if (!needSession($('mapNote')) || !layouts.length) return;
    try {
      await postJson(`/api/admin/sessions/${sessionId}/settings`, { layout: layouts[0].id });
      await loadSessions();
    } catch (err) { msg($('mapNote'), 'err', err.message); }
  };
  function renderLevelChips(levels) {
    const box = $('mapLevels');
    box.innerHTML = '';
    for (const l of ['', ...levels]) {
      const b = document.createElement('button');
      b.className = 'chip-btn' + (l === mapLevel ? ' selected' : '');
      b.textContent = l || 'All';
      b.onclick = () => { mapLevel = l; refreshMap(); };
      box.appendChild(b);
    }
  }

  let lastMap = { aisles: [], bins: [] };

  async function refreshMap() {
    const data = await apiJson(`/api/admin/sessions/${sessionId}/map`);
    lastMap = data;
    const svg = $('map');
    svg.innerHTML = '';
    const levels = [...new Set(data.bins.map(([code]) => parseBinCode(code).level).filter(Boolean))].sort();
    renderLevelChips(levels);
    if (mapLevel) data.bins = data.bins.filter(([code]) => parseBinCode(code).level === mapLevel);
    $('mapSub').textContent = data.layout ? data.layout.name : 'top-down, built from the bin codes · aisles that share racking are drawn back-to-back';
    // An empty map card reads as broken, so say which of the two things is missing.
    showMapFix(!data.layout && layouts.length > 0, data.bins.length > 0);
    if (!data.bins.length) {
      $('mapNote').textContent = 'No bins in this session yet — upload its bin list under Settings and the map draws itself.';
      svg.setAttribute('height', 0);
      return;
    }
    const r = data.layout ? renderBlueprint(svg, data, data.layout) : renderSchematic(svg, data);
    if (selectedAisle && !data.aisles.some((a) => a.aisle === selectedAisle)) selectedAisle = '';
    selectAisle(selectedAisle);   // redraw keeps the selection
    $('mapNote').textContent = `${mapLevel ? 'Level ' + mapLevel + ': ' : ''}${r.counted.toLocaleString()} of ${r.total.toLocaleString()} bins have a count. Each cell is a bay; hover for the bins in it.` +
      (r.missing.length ? ` Not on the drawing — ${r.missing.join(' · ')}.` : '');
  }

  /* ------------------------------------------------- filed as the count goes
     What the server has written to disk for this count: one folder per aisle
     handed back, and the final report when the count is whole. */
  let finalReady = null;
  async function refreshArchives() {
    if (!sessionId || !$('archiveTable')) return;
    const d = await apiJson(`/api/admin/sessions/${sessionId}/archives`);
    finalReady = d.readiness;
    const btn = $('btnFinalReport');
    const may = api.can('export');
    btn.disabled = !may || !d.readiness.ready;
    $('finalWhy').textContent = !may ? 'This login cannot download exports.'
      : d.readiness.ready ? `Every bin counted (${d.readiness.binsCounted.toLocaleString()} of ${d.readiness.binsTotal.toLocaleString()}), no second counts open — the count is whole.`
        : `Not yet: ${d.readiness.reasons.join(', ')}.`;
    table($('archiveTable'),
      [{ label: 'Filed' }, { label: 'What' }, { label: 'Files' }],
      d.archives,
      (a) => {
        const tr = document.createElement('tr');
        const what = document.createElement('td');
        what.appendChild(tag(a.kind === 'final' ? 'done' : 'ok', a.kind === 'final' ? 'final' : 'aisle'));
        what.append(' ' + (a.kind === 'final' ? 'Final report — the whole count' : `Aisle ${a.aisle} handed back`));
        const files = document.createElement('td');
        files.className = 'wrap';
        a.files.forEach((f, i) => {
          const link = document.createElement('a');
          link.href = '#';
          link.className = 'tlink';
          link.textContent = f.name;
          link.title = `${(f.bytes / 1024).toFixed(1)} KB`;
          link.onclick = (e) => { e.preventDefault(); api.download(`/api/admin/sessions/${sessionId}/archives/file?folder=${encodeURIComponent(a.name)}&file=${encodeURIComponent(f.name)}`, `${a.name}-${f.name}`); };
          if (i) files.append(' · ');
          files.appendChild(link);
        });
        tr.append(cell(new Date(a.at).toLocaleString()), what, files);
        return tr;
      },
      'Nothing filed yet — the first aisle handed back starts it.');
  }
  $('btnFinalReport').onclick = async () => {
    if (!sessionId) return;
    try {
      const out = await postJson(`/api/admin/sessions/${sessionId}/archives/final`, {});
      msg($('archiveMsg'), 'ok', `Final report filed: ${out.sheets} sheets in ${out.name}.`, 'Download the files below, or Export everything for the workbook.');
      await refreshArchives();
    } catch (err) { msg($('archiveMsg'), 'err', 'Not filed', err.message); }
  };

  /** Re-read the session list so the header picker's progress stays live. */
  async function refreshPicker() {
    sessions = await apiJson(SESSIONS_URL);
    // cycle counts switched off for the site: Inventory Control lists none of them
    if (IC && !api.on('cycle')) sessions = sessions.filter((s) => s.mode !== 'cycle');
    picker.render(sessions, sessionId);
  }

  /* ---------------------------------------------------------- the systems
     Three ERPs share this warehouse. Each pallet row carries the system its
     report came from, so the office can read the count one system at a time;
     the guns never see it. The pickers here are filled from what is loaded. */
  let sources = [];
  const sourceValue = (src) => (src === '' ? '~none' : src);        // '' on a picker means "every system"
  const sourceParam = (sel) => { const v = $(sel).value; return v === '' ? null : (v === '~none' ? '' : v); };
  async function refreshSources() {
    sources = (await apiJson(`/api/admin/sessions/${sessionId}/sources`)).sources || [];
    const named = sources.filter((x) => x.source);
    for (const id of ['fPalletSource', 'fAdjSource']) {
      const sel = $(id);
      const was = sel.value;
      sel.innerHTML = '<option value="">Every system</option>';
      for (const x of sources) {
        const o = document.createElement('option');
        o.value = sourceValue(x.source);
        o.textContent = x.source || 'No system named';
        sel.appendChild(o);
      }
      if ([...sel.options].some((o) => o.value === was)) sel.value = was;
      sel.closest('label').hidden = !named.length;
    }
    const box = $('bySystem');
    box.hidden = !named.length;
    box.innerHTML = '';
    for (const x of sources) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = `${Number(x.counted).toLocaleString()} / ${Number(x.pallets).toLocaleString()}`;
      d.querySelector('.l').textContent = x.source ? `${x.source} — pallets found` : 'No system named — pallets found';
      box.appendChild(d);
    }
  }

  /* Only the tabs this login has are fetched: a tab it may not open would be
     refused by the server, and one refusal must not stop the rest. */
  const tab = (name) => api.canTab(PAGE, name);
  /* Only what is on screen is fetched: the pallet report of a twenty-thousand-bin
     count is not pulled every half minute by a page sitting on Progress. The
     progress figures (the header's percentage) and the alerts (the SOS bar, the
     badge) are light and always wanted. A pane that becomes visible is fetched
     at once, on the subshow event below. */
  // function declarations, so the first refresh - which runs before this line - can use them
  function shown(name) { const pane = document.querySelector(`[data-sub="${name}"]`); return !!pane && (pane.classList.contains('active') || pane.getClientRects().length > 0); }
  function paneJobs() {
    return {
      progress: [refreshNotes, refreshProgress], teams: [refreshAssignments], reports: [refreshPallets, refreshLabels, refreshArchives], map: [refreshMap],
      overview: [refreshOverview], second: [refreshRecounts], alerts: [refreshMessages, refreshAlerts], adjust: [refreshAdjustments, () => refreshErpAisles().catch(() => {})],
    };
  }
  /* ------------------------------------------------------- Inventory Control's overview
     Where the count stands for inventory control, in one read. */
  async function refreshOverview() {
    const o = await apiJson(`/api/admin/sessions/${sessionId}/inventory-control`);
    const n = (v) => Number(v || 0).toLocaleString();
    const sign = (v) => (v > 0 ? '+' : '') + Number(v || 0).toLocaleString();
    $('icKind').textContent = o.session.mode === 'cycle' ? 'CYCLE' : 'FULL';
    $('icSub').textContent = `${o.session.name}${o.session.closed || o.session.status === 'closed' ? ' · closed' : ''}`;
    const pct = o.session.bins ? Math.round((o.session.binsCounted / o.session.bins) * 1000) / 10 : 0;
    const stats = [
      [`${pct}%`, `counted · ${n(o.session.binsCounted)} of ${n(o.session.bins)} bins`, 'progress'],
      [n(o.recounts.stillOpen), `second counts still open${o.recounts.thirdOpen ? ` · ${n(o.recounts.thirdOpen)} third` : ''}`, 'second'],
      [n(o.recounts.done), 'second counts done', 'second'],
      [sign(o.adjustments.positive.units), `positive · ${n(o.adjustments.positive.pallets)} pallet${o.adjustments.positive.pallets === 1 ? '' : 's'}`, 'adjust'],
      [sign(o.adjustments.negative.units), `negative · ${n(o.adjustments.negative.pallets)} pallet${o.adjustments.negative.pallets === 1 ? '' : 's'}`, 'adjust'],
      [sign(o.adjustments.net), 'net units', 'adjust'],
    ];
    if (o.adjustments.approvals) stats.push([n(o.adjustments.pending), `adjustments to approve · ${n(o.adjustments.approved)} approved`, 'adjust']);
    stats.push([`${n(o.erp.entered)} / ${n(o.erp.lines)}`, `lines in the ERP · ${n(o.erp.aislesAll)} of ${n(o.erp.aisles)} aisles done`, 'adjust']);
    if (o.erp.changed) stats.push([n(o.erp.changed), 'lines changed since they went in', 'adjust']);
    const box = $('icStats');
    box.replaceChildren();
    for (const [big, label, go] of stats) {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'stat';
      d.dataset.icStat = go;
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = big;
      d.querySelector('.l').textContent = label;
      if (go !== 'progress' && tab(go)) d.onclick = () => api.showSub(go); else d.disabled = true;
      box.appendChild(d);
    }
    const fin = $('icFinal');
    if (o.final.closed) { fin.className = 'feedback show ok'; fin.textContent = 'This count is closed. Its reports and the ERP sheets are under Reports and Adjustments.'; }
    else if (o.final.ready) { fin.className = 'feedback show ok'; fin.textContent = 'No second counts open: the final report can be filed (Reports → Filed as the count goes).'; }
    else { fin.className = 'feedback show warn'; fin.textContent = `${n(o.final.blockedBy)} second count${o.final.blockedBy === 1 ? ' is' : 's are'} still open — the final report waits until the list is at zero.`; }
    // the cycle counts still open, while cycle counts are on
    $('icCycleCard').hidden = !o.cycles || !o.cycles.length;
    if (o.cycles && o.cycles.length) {
      table($('icCycles'), [{ label: 'Cycle count' }, { label: 'Bins counted', num: true }, { label: 'Second counts open', num: true }, { label: '' }], o.cycles, (c) => {
        const tr = document.createElement('tr');
        tr.dataset.cycle = c.id;
        tr.append(cell(c.name), cell(`${n(c.bins_counted)} of ${n(c.bins)}`), cell(n(c.recounts_open)));
        const td = document.createElement('td');
        td.appendChild(c.id === sessionId ? tag('showing', 'ok') : button('Show it here', 'sm', () => api.pickSession(c.id)));
        tr.appendChild(td);
        return tr;
      }, 'None open.');
    }
    $('icMissingCard').hidden = !o.missing;
    if (o.missing) {
      const mb = $('icMissing');
      mb.replaceChildren();
      for (const [big, label] of [[n(o.missing.missing), 'still being looked for'], [n(o.missing.found), 'found'], [n(o.missing.closed), 'closed']]) {
        const d = document.createElement('div'); d.className = 'stat';
        d.innerHTML = '<div class="n"></div><div class="l"></div>';
        d.querySelector('.n').textContent = big; d.querySelector('.l').textContent = label;
        mb.appendChild(d);
      }
    }
  }
  for (const b of document.querySelectorAll('[data-ic-go]')) b.onclick = () => api.showSub(b.dataset.icGo);
  if ($('icMissingLink')) $('icMissingLink').onclick = () => { location.href = '/missing'; };

  async function refreshAll() {
    if (!sessionId) return;
    const jobs = [refreshSources, refreshPicker, refreshProgress, refreshAlerts];
    for (const [name, fns] of Object.entries(paneJobs())) if (tab(name) && shown(name)) for (const f of fns) if (!jobs.includes(f)) jobs.push(f);
    await Promise.all(jobs.map((f) => Promise.resolve().then(f).catch(() => {})));
  }

  /* ------------------------------------------------------- adjustments
     What this count would do to the ERP, and who signed for it. The list is
     rebuilt from the report every time it is read, so a variance a second count
     has since cleared stops asking to be approved. */
  let adjustState = { on: false, reasons: [], adjustments: [] };
  const picked = new Set();

  /* Positive and negative: what the count adds and what it takes off, with or
     without approvals. One click on a tile shows that side. */
  let pnData = null;
  let pnSide = (() => { try { return sessionStorage.getItem('pnSide') || 'positive'; } catch { return 'positive'; } })();
  const signed = (n) => (n > 0 ? '+' : '') + Number(n || 0).toLocaleString();

  async function refreshPositiveNegative() {
    pnData = await apiJson(`/api/admin/sessions/${sessionId}/adjustments/view`);
    renderPositiveNegative();
  }

  const erpPicked = new Set();           // lines ticked for "entered in the ERP"
  function pnRows() {
    if (!pnData) return [];
    const hide = $('fPnHideEntered').checked;
    const rows = pnSide === 'positive' ? pnData.positive.rows : pnSide === 'negative' ? pnData.negative.rows : [...pnData.positive.rows, ...pnData.negative.rows];
    return hide ? rows.filter((r) => !r.erp) : rows;
  }

  function renderPositiveNegative() {
    const d = pnData;
    $('pnPlusUnits').textContent = signed(d.positive.units);
    $('pnPlusSub').textContent = `${d.positive.pallets.toLocaleString()} pallet${d.positive.pallets === 1 ? '' : 's'}`;
    $('pnMinusUnits').textContent = signed(d.negative.units);
    $('pnMinusSub').textContent = `${d.negative.pallets.toLocaleString()} pallet${d.negative.pallets === 1 ? '' : 's'}`;
    $('pnNet').textContent = signed(d.net);
    for (const b of document.querySelectorAll('#pnSide button, #pnTiles button')) b.classList.toggle('selected', b.dataset.side === pnSide);
    const cols = [{ label: '' }, { label: 'Pallet' }, { label: 'System' }, { label: 'Item' }, { label: 'Bin' }, { label: 'Why' },
      { label: 'Report qty', num: true }, { label: 'Counted', num: true }, { label: 'Adjustment', num: true }];
    if (d.approvals) cols.push({ label: 'Approval' });
    cols.push({ label: 'In ERP' });
    const shown = pnRows();
    for (const id of [...erpPicked]) if (!shown.some((r) => r.pallet_id === id)) erpPicked.delete(id);
    table($('pnTable'), cols, shown, (r) => {
      const tr = document.createElement('tr');
      tr.dataset.pallet = r.pallet_id;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'erpPick';
      box.checked = erpPicked.has(r.pallet_id);
      box.onchange = () => { if (box.checked) erpPicked.add(r.pallet_id); else erpPicked.delete(r.pallet_id); };
      const tdBox = document.createElement('td');
      tdBox.appendChild(box);
      const adj = cell(signed(r.variance_qty), 'num ' + (r.variance_qty > 0 ? 'pos' : 'neg'));
      tr.append(tdBox, cell(r.pallet_id), cell(r.source || '—'), cell(r.sku || '—'), cell(r.location || '—'), cell(r.why, 'wrap'),
        cell(r.expected_qty == null ? '—' : r.expected_qty, 'num'), cell(r.counted_qty, 'num'), adj);
      if (d.approvals) tr.appendChild(cell(r.status ? r.status + (r.decided_by ? ` · ${r.decided_by}` : '') : '—'));
      const te = document.createElement('td');
      if (r.erp) {
        te.appendChild(tag(r.erp.changed ? 'CHANGED' : 'IN ERP'));
        const who = document.createElement('div');
        who.className = 'muted';
        who.style.fontSize = '11px';
        who.textContent = `${r.erp.by || ''} ${new Date(r.erp.at).toLocaleDateString()}${r.erp.changed ? ` · entered as ${signed(r.erp.qty)}` : ''}`.trim();
        te.appendChild(who);
        te.title = r.erp.changed ? `Entered in the ERP as ${signed(r.erp.qty)}; the count now says ${signed(r.variance_qty)}` : `Entered in the ERP by ${r.erp.by || 'a supervisor'} on ${new Date(r.erp.at).toLocaleString()}`;
      } else te.textContent = '—';
      tr.appendChild(te);
      return tr;
    }, pnSide === 'negative' ? 'Nothing to take off.' : pnSide === 'positive' ? 'Nothing to add.' : 'The count matches the report so far.');
    const e = d.erp || { entered: 0, total: 0, changed: 0 };
    $('erpChip').hidden = !e.total;
    $('erpChip').textContent = `${e.entered} of ${e.total} entered${e.changed ? ` · ${e.changed} changed since` : ''}`;
    $('erpChip').className = 'chip ' + (e.changed ? 'warn' : e.total && e.entered === e.total ? 'online' : '');
    $('pnNote').textContent = d.closed ? ''
      : 'The count is still open: a pallet nobody has reached yet is not counted as missing. Once the count is closed, pallets never found are added to Negative.';
  }

  for (const b of document.querySelectorAll('#pnSide button, #pnTiles button')) {
    b.onclick = () => {
      pnSide = b.dataset.side;
      try { sessionStorage.setItem('pnSide', pnSide); } catch { /* private window */ }
      if (pnData) renderPositiveNegative();
    };
  }
  $('fPnHideEntered').onchange = () => { if (pnData) renderPositiveNegative(); };
  /* entered in the ERP: a few lines at a time from the table, or the worksheet brought back */
  async function erpMark(on) {
    if (!needSession($('erpMsg'))) return;
    if (!erpPicked.size) { msg($('erpMsg'), 'err', 'Nothing selected', 'Tick the lines you keyed into the ERP first.'); return; }
    try {
      const out = await postJson(`/api/admin/sessions/${sessionId}/erp-entries`, { pallets: [...erpPicked], on });
      erpPicked.clear();
      msg($('erpMsg'), 'ok', on ? `${out.marked} line${out.marked === 1 ? '' : 's'} marked as entered in the ERP.` : `The mark is off ${out.unmarked} line${out.unmarked === 1 ? '' : 's'}.`, `${out.entered} of ${out.total} entered.`);
      await refreshPositiveNegative();
    } catch (err) { msg($('erpMsg'), 'err', err.message); }
  }
  $('btnErpMark').onclick = () => erpMark(true);
  $('btnErpUnmark').onclick = () => erpMark(false);
  $('btnErpAll').onclick = () => { for (const r of pnRows()) erpPicked.add(r.pallet_id); renderPositiveNegative(); };
  $('btnErpNone').onclick = () => { erpPicked.clear(); renderPositiveNegative(); };
  $('btnErpWorksheet').onclick = () => { if (needSession($('erpMsg'))) api.download(`/api/admin/sessions/${sessionId}/export/erp-worksheet.csv`, `erp-worksheet-session-${sessionId}.csv`); };
  $('fErpFile').onchange = async () => {
    const file = $('fErpFile').files[0];
    if (!file || !needSession($('erpMsg'))) return;
    try {
      const text = await window.appUi.fileToCsv(file);
      const res = await fetch(`/api/admin/sessions/${sessionId}/erp-entries/upload`, { method: 'POST', headers: { 'content-type': 'text/csv', authorization: 'Bearer ' + api.token }, body: text });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'the upload failed');
      msg($('erpMsg'), 'ok', `From the worksheet: ${out.marked} marked as entered, ${out.unmarked} unmarked, ${out.skipped} left alone.`,
        `${out.entered} of ${out.total} entered.${out.unknown.length ? ` Not on this count, ignored: ${out.unknown.slice(0, 5).join(', ')}${out.unknown.length > 5 ? '…' : ''}.` : ''}`);
      await refreshPositiveNegative();
    } catch (err) { msg($('erpMsg'), 'err', 'Not applied', err.message); }
    $('fErpFile').value = '';
  };
  /* ------------------------------------------- the ERP, an aisle at a time */
  async function refreshErpAisles() {
    if (!sessionId || !$('erpAislesTable')) return;
    const { aisles } = await apiJson(`/api/admin/sessions/${sessionId}/erp-entries/aisles`);
    const done = aisles.filter((a) => a.state === 'all').length;
    $('erpAislesChip').hidden = !aisles.length;
    $('erpAislesChip').textContent = `${done} of ${aisles.length} aisles uploaded`;
    $('erpAislesChip').className = 'chip ' + (aisles.length && done === aisles.length ? 'online' : '');
    const rows = $('fErpAislesTodo').checked ? aisles.filter((a) => a.state !== 'all' || a.changed) : aisles;
    table($('erpAislesTable'),
      [{ label: 'Aisle' }, { label: 'Pallets', num: true }, { label: 'Counted', num: true }, { label: 'Differences', num: true },
       { label: 'Uploaded to ERP' }, { label: 'Still being counted' }, { label: '' }],
      rows,
      (a) => {
        const tr = document.createElement('tr');
        tr.dataset.aisle = a.aisle;
        tr.append(cell(a.aisle), cell(a.lines.toLocaleString(), 'num'), cell(a.counted.toLocaleString(), 'num'), cell(a.differences.toLocaleString(), 'num'));
        const up = document.createElement('td');
        up.appendChild(tag(a.state === 'all' ? 'MATCH' : a.state === 'some' ? 'queued' : 'off', a.state === 'all' ? 'all in the ERP' : a.state === 'some' ? `${a.uploaded} of ${a.lines}` : 'not yet'));
        if (a.changed) { const w = tag('QTY VARIANCE', `${a.changed} changed since`); w.style.marginLeft = '6px'; w.title = 'Counted again after it went into the ERP: the ERP has the old number'; up.appendChild(w); }
        tr.appendChild(up);
        const busy = [a.openRecounts ? `${a.openRecounts} 2nd/3rd count${a.openRecounts === 1 ? '' : 's'} open` : '', a.binsNotCounted ? `${a.binsNotCounted} bin${a.binsNotCounted === 1 ? '' : 's'} not counted` : ''].filter(Boolean).join(' · ');
        tr.appendChild(cell(busy || (a.handedBack ? 'done' : '—'), busy ? 'warn' : ''));
        const act = document.createElement('td');
        const b = document.createElement('button'); b.className = 'sm'; b.textContent = '⬇ Excel'; b.dataset.erpAisle = a.aisle;
        b.title = `Every pallet in ${a.aisle}, with an "Uploaded to ERP" column to fill in`;
        b.onclick = async () => {
          b.disabled = true;
          try {
            const [data, XLSX] = await Promise.all([apiJson(`/api/admin/sessions/${sessionId}/export/erp-aisle?aisle=${encodeURIComponent(a.aisle)}`), window.appUi.loadXlsx()]);
            writeWorkbook(XLSX, data);
            msg($('erpAislesMsg'), busy ? 'warn' : 'ok', `${a.aisle}: ${data.lines} lines`, busy ? `Still being counted (${busy}) — numbers there may change.` : data.filename);
          } catch (err) { msg($('erpAislesMsg'), 'err', err.message); }
          finally { b.disabled = false; }
        };
        act.appendChild(b);
        tr.appendChild(act);
        return tr;
      }, aisles.length ? 'Every aisle is in the ERP.' : 'Nothing counted on this count yet.');
  }
  $('fErpAislesTodo').onchange = () => refreshErpAisles().catch(() => {});
  /* A filled-in sheet back: every sheet in the workbook that has the column is read, so a
     workbook with several aisles' sheets pasted into it works too. */
  $('fErpAisleFile').onchange = async () => {
    const file = $('fErpAisleFile').files[0];
    $('fErpAisleFile').value = '';
    if (!file || !needSession($('erpAislesMsg'))) return;
    try {
      let parts;
      if (/\.xls[xm]?$/i.test(file.name)) {
        const XLSX = await window.appUi.loadXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        parts = wb.SheetNames.map((n) => ({ name: n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n]) })).filter((x) => /uploaded to erp|in erp/i.test(x.csv.split('\n')[0] || ''));
      } else parts = [{ name: file.name, csv: await file.text() }];
      if (!parts.length) throw new Error('no sheet in it has an "Uploaded to ERP" column - download an aisle with ⬇ Excel, fill that column in, and upload it');
      const tot = { marked: 0, unmarked: 0, already: 0, skipped: 0, remarked: 0, unknown: [] };
      for (const part of parts) {
        const aisle = (part.name.match(/^Aisle\s+(\S+)/i) || [])[1] || '';
        const res = await fetch(`/api/admin/sessions/${sessionId}/erp-entries/upload${aisle ? `?aisle=${encodeURIComponent(aisle)}` : ''}`,
          { method: 'POST', headers: { 'content-type': 'text/csv', authorization: 'Bearer ' + api.token }, body: part.csv });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || 'the upload failed');
        for (const k of ['marked', 'unmarked', 'already', 'skipped', 'remarked']) tot[k] += out[k] || 0;
        tot.unknown.push(...(out.unknown || []));
      }
      msg($('erpAislesMsg'), 'ok', `${file.name}: ${tot.marked} line${tot.marked === 1 ? '' : 's'} marked as uploaded to the ERP${tot.unmarked ? `, ${tot.unmarked} unmarked` : ''}`,
        [tot.remarked ? `${tot.remarked} put right in the ERP and marked again at today's numbers.` : '',
          tot.already ? `${tot.already} were marked already.` : '', tot.skipped ? `${tot.skipped} left blank, left as they were.` : '',
          tot.unknown.length ? `Not on this count, ignored: ${tot.unknown.slice(0, 5).join(', ')}${tot.unknown.length > 5 ? '…' : ''}.` : ''].filter(Boolean).join(' '));
      await Promise.all([refreshErpAisles(), refreshPositiveNegative().catch(() => {})]);
    } catch (err) { msg($('erpAislesMsg'), 'err', 'Not applied', err.message); }
  };

  $('btnPnCsv').onclick = () => {
    const rows = pnRows();
    const head = ['Pallet', 'Item', 'Bin', 'Why', 'System qty', 'Counted qty', 'Adjustment', 'Approval', 'In ERP'];
    const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [head, ...rows.map((r) => [r.pallet_id, r.sku, r.location, r.why, r.expected_qty ?? '', r.counted_qty, r.variance_qty, r.status, r.erp ? 'yes' : ''])]
      .map((l) => l.map(q).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines], { type: 'text/csv' }));
    a.download = `adjustments-${pnSide}-session-${sessionId}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  async function refreshAdjustments() {
    refreshPositiveNegative().catch(() => {});
    const s = sessions.find((x) => x.id === sessionId);
    const on = !!(s && s.require_approval);
    $('adjustOff').hidden = on;
    $('adjustBody').hidden = !on;
    $('adjustSub').textContent = on ? 'what this count would do to the ERP' : 'off for this count';
    if (!on) return;
    const data = await apiJson(`/api/admin/sessions/${sessionId}/adjustments`);
    adjustState = data;

    const sel = $('fAdjReason');
    const want = data.reasons.join('|');
    if (sel.dataset.built !== want) {
      sel.dataset.built = want;
      sel.innerHTML = '';
      for (const r of ['Choose a reason…', ...data.reasons, 'Other']) {
        const o = document.createElement('option');
        o.textContent = r;
        if (r === 'Choose a reason…') o.value = '';
        sel.appendChild(o);
      }
    }

    const sum = data.summary;
    $('adjustStats').innerHTML = '';
    for (const [n, l] of [
      [sum.pending, 'Waiting for approval'],
      [sum.approved, 'Approved'],
      [sum.rejected, 'Rejected — the system keeps its number'],
      [sum.auto, `Under the threshold${data.thresholds.minQty || data.thresholds.minPct ? '' : ' (none set)'}`],
      [Math.round(sum.units.pending).toLocaleString(), 'Units still unsigned'],
    ]) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      $('adjustStats').appendChild(d);
    }

    const pendingOnly = $('fAdjPendingOnly').checked;
    const adjSrc = sourceParam('fAdjSource');
    const rows = data.adjustments.filter((r) => (!pendingOnly || r.status === 'pending') && (adjSrc == null || (r.source || '') === adjSrc));
    for (const id of [...picked]) if (!rows.some((r) => r.pallet_id === id)) picked.delete(id);

    table($('adjustTable'),
      [{ label: '' }, { label: 'Pallet' }, { label: 'System' }, { label: 'Item' }, { label: 'Bin' }, { label: 'Found' },
        { label: 'Report qty', num: true }, { label: 'Counted', num: true }, { label: 'Adjustment', num: true },
        { label: 'Status' }, { label: 'Reason' }, { label: 'Signed by' }],
      rows,
      (r) => {
        const tr = document.createElement('tr');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = picked.has(r.pallet_id);
        /* Under the threshold: it goes to the ERP without anybody being asked,
           so there is nothing here to sign. */
        box.disabled = r.status === 'auto';
        box.onchange = () => { if (box.checked) picked.add(r.pallet_id); else picked.delete(r.pallet_id); };
        const td = document.createElement('td');
        td.appendChild(box);
        tr.append(td, cell(r.pallet_id), cell(r.source || '—'), cell(r.sku || '—'), cell(r.location || '—'), cell(r.kind),
          cell(r.expected_qty == null ? '—' : r.expected_qty, 'num'),
          cell(r.counted_qty == null ? '—' : r.counted_qty, 'num'),
          cell((r.variance_qty > 0 ? '+' : '') + r.variance_qty, 'num'));
        const st = document.createElement('td');
        st.appendChild(tag(r.status === 'auto' ? 'AUTO' : r.status.toUpperCase()));
        tr.append(st, cell(r.reason || '—', 'wrap'), cell(r.decided_by || '—'));
        return tr;
      },
      'Nothing differs from the report on this count.');

    $('adjustNote').textContent = `${rows.length} shown of ${data.adjustments.length}`
      + (data.thresholds.minQty || data.thresholds.minPct
        ? ` · anything under ${data.thresholds.minQty} units and ${data.thresholds.minPct}% goes through unsigned`
        : ' · every difference needs approving (no threshold set)')
      + (data.reopened ? ` · ${data.reopened} came back for approval after being counted again` : '');
  }

  async function decide(decision) {
    if (!needSession($('adjustMsg'))) return;
    if (!picked.size) { msg($('adjustMsg'), 'err', 'Nothing selected', 'Tick the pallets to decide on first.'); return; }
    const reason = $('fAdjReason').value;
    const note = $('fAdjNote').value.trim();
    if (!reason && !note) {
      msg($('adjustMsg'), 'err', 'A reason is required', 'Pick one, or write one in the note — that is the point of approving it.');
      return;
    }
    try {
      const out = await postJson(`/api/admin/sessions/${sessionId}/adjustments/decide`,
        { palletIds: [...picked], decision, reason, note });
      picked.clear();
      $('fAdjNote').value = '';
      msg($('adjustMsg'), 'ok', `${out.decided} ${decision === 'reject' ? 'rejected' : 'approved'} — ${out.reason}`,
        `${out.summary.pending} still waiting.`);
      await refreshAdjustments();
    } catch (err) { msg($('adjustMsg'), 'err', err.message); }
  }

  $('btnApprove').onclick = () => decide('approve');
  $('btnReject').onclick = () => decide('reject');
  $('fAdjPendingOnly').onchange = () => refreshAdjustments().catch(() => {});
  $('btnAdjAll').onclick = () => {
    for (const r of (adjustState.adjustments || [])) {
      if (r.status !== 'auto' && (!$('fAdjPendingOnly').checked || r.status === 'pending')) picked.add(r.pallet_id);
    }
    refreshAdjustments().catch(() => {});
  };
  $('btnAdjNone').onclick = () => { picked.clear(); refreshAdjustments().catch(() => {}); };
  $('btnExportAdjust').onclick = () =>
    api.download(`/api/admin/sessions/${sessionId}/export/adjustments.csv`, `adjustments-session-${sessionId}.csv`);

  /* ----------------------------------------------------- labels to replace
     A label that would not scan is a pallet the next person cannot scan either.
     This is the walk-round afterwards, with a printer. */
  /* The fix list: labels to replace, damage, blocked bins - one list, ticked
     off as it is dealt with. */
  let fixStatus = 'open';
  const FIX_KIND = { label: 'LABEL', damage: 'DAMAGE', blocked: 'BLOCKED', other: 'OTHER' };
  const FIX_WHAT = { pallet: 'pallet', rack: 'rack', product: 'product', bin: 'bin', '': '' };

  async function refreshLabels() {
    const d = await apiJson(`/api/admin/sessions/${sessionId}/fixlist${fixStatus ? '?status=' + fixStatus : ''}`);
    const s = d.summary;
    $('fixSub').textContent = s.open ? `${s.open} to put right` : s.fixed ? 'everything reported has been dealt with' : 'nothing reported — a clean walk';
    $('fixStats').innerHTML = '';
    for (const [n, l] of [[s.labels, 'Labels to replace'], [s.damage, 'Damage'], [s.blocked, 'Blocked bins to go back to'], [s.other, 'Other'], [s.fixed, 'Fixed']]) {
      const el = document.createElement('div');
      el.className = 'stat';
      el.innerHTML = '<div class="n"></div><div class="l"></div>';
      el.querySelector('.n').textContent = n;
      el.querySelector('.l').textContent = l;
      $('fixStats').appendChild(el);
    }
    for (const b of document.querySelectorAll('#fixFilter button')) b.classList.toggle('selected', b.dataset.status === fixStatus);
    table($('fixTable'),
      [{ label: 'Kind' }, { label: 'Bin' }, { label: 'Aisle' }, { label: 'Pallet' }, { label: 'Problem' }, { label: 'Reported by' }, { label: 'When' }, { label: 'State' }, { label: '' }],
      d.rows,
      (r) => {
        const tr = document.createElement('tr');
        const k = document.createElement('td');
        k.appendChild(tag(FIX_KIND[r.kind] || r.kind));
        if (r.target) k.append(' ' + FIX_WHAT[r.target]);
        const st = document.createElement('td');
        st.appendChild(tag(r.status === 'fixed' ? 'done' : 'open'));
        if (r.status === 'fixed') st.append(` ${r.fixed_by || ''}${r.outcome ? ' · ' + r.outcome : ''}`);
        const act = document.createElement('td');
        if (r.id && r.status === 'open') act.appendChild(button('Fixed', 'sm primary', () => fixItem(r.id, false)));
        else if (r.id) act.appendChild(button('Reopen', 'sm', () => fixItem(r.id, true)));
        /* a label to replace: ticked off once it is printed and on the pallet or the rack */
        else if (r.label && r.status === 'open') act.appendChild(button(r.target === 'rack' ? 'Label printed & on the rack' : 'Label printed & on the pallet', 'sm primary', () => fixLabelRow(r.label, false)));
        else if (r.label) act.appendChild(button('Reopen', 'sm', () => fixLabelRow(r.label, true)));
        /* what the counter scanned to say which one it is - typed when the label would not scan */
        const conf = (what) => {
          const td = cell((what === 'bin' ? r.bin : r.pallet_id) || '—');
          if (r.confirmed && r.confirmed_as === what) {
            td.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: r.confirmed_how === 'typed' ? '✓ typed on the gun' : '✓ scanned' }));
            td.title = r.confirmed_how === 'typed' ? 'The counter typed this one in: its label would not scan' : 'The counter scanned this to confirm it';
          }
          return td;
        };
        tr.append(k, conf('bin'), cell(r.aisle || '—'), conf('pallet'), cell(r.note ? `${r.reason} — ${r.note}` : r.reason, 'wrap'),
          cell(r.team ? `team ${r.team}${r.device_id ? ' · ' + r.device_id : ''}` : r.device_id || '—'), cell(r.created_at ? new Date(r.created_at).toLocaleString() : '—'), st, act);
        return tr;
      },
      fixStatus === 'open' ? 'Nothing open — every label scanned, nothing reported.' : fixStatus === 'fixed' ? 'Nothing fixed yet.' : 'Nothing reported on this count.');
  }
  async function fixItem(id, reopen) {
    let outcome = '';
    if (!reopen) { outcome = prompt('Mark it fixed — what was done? (optional)') ?? null; if (outcome === null) return; }
    try { await postJson(`/api/admin/sessions/${sessionId}/issues/${id}/fix`, { outcome, reopen }); await refreshLabels(); }
    catch (err) { msg($('fixMsg'), 'err', err.message); }
  }
  async function fixLabelRow(label, reopen) {
    try { await postJson(`/api/admin/sessions/${sessionId}/labels/fix`, { what: label.what, code: label.code, reopen }); await refreshLabels(); }
    catch (err) { msg($('fixMsg'), 'err', err.message); }
  }
  for (const b of document.querySelectorAll('#fixFilter button')) b.onclick = () => { fixStatus = b.dataset.status; refreshLabels().catch(() => {}); };
  $('btnExportFix').onclick = () => api.download(`/api/admin/sessions/${sessionId}/export/fixlist.csv`, `fix-list-session-${sessionId}.csv`);
  $('btnExportLabels').onclick = () =>
    api.download(`/api/admin/sessions/${sessionId}/export/labels.csv`, `labels-to-replace-session-${sessionId}.csv`);

  /* --------------------------------------------------- a note on the board
     One line across the top of the board screen: when lunch is, which dock is
     blocked. The floor reads it walking past; the scanners have messages. */
  /* The notes on the board: added, changed and taken down one by one. */
  let notes = [];
  function renderNotes() {
    const box = $('noteList');
    box.innerHTML = '';
    for (const x of notes) {
      const row = document.createElement('div');
      row.className = 'noterow';
      const t = document.createElement('div'); t.className = 'txt'; t.textContent = x.text;
      const who = document.createElement('div'); who.className = 'muted';
      who.textContent = `${x.by || 'somebody'} · ${new Date(x.at).toLocaleString()}${x.updated_at ? ` · changed ${new Date(x.updated_at).toLocaleString()}${x.updated_by ? ' by ' + x.updated_by : ''}` : ''}`;
      const acts = document.createElement('div'); acts.className = 'acts';
      acts.appendChild(button('Edit', 'sm', async () => {
        const next = prompt('Change the note:', x.text);
        if (next === null) return;
        try { notes = (await postJson(`/api/admin/sessions/${sessionId}/notes/${x.id}`, { text: next })).notes; renderNotes(); msg($('noteMsg'), 'ok', 'Changed.', 'The board picks it up within a few seconds.'); }
        catch (err) { msg($('noteMsg'), 'err', err.message); }
      }));
      acts.appendChild(button('Delete', 'sm danger', async () => {
        if (!confirm('Take this note off the board?')) return;
        try { notes = (await apiJson(`/api/admin/sessions/${sessionId}/notes/${x.id}`, { method: 'DELETE' })).notes; renderNotes(); msg($('noteMsg'), 'ok', 'Taken off the board.'); }
        catch (err) { msg($('noteMsg'), 'err', err.message); }
      }));
      if (!api.can('assign')) for (const b of acts.querySelectorAll('button')) { b.disabled = true; b.title = 'Not able to: this login may not change the board.'; }
      row.append(t, who, acts);
      box.appendChild(row);
    }
    $('noteWho').textContent = notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'} on the board.` : 'Nothing on the board at the moment.';
  }
  async function refreshNotes() {
    if (!sessionId) return;
    notes = (await apiJson(`/api/admin/sessions/${sessionId}/notes`)).notes || [];
    renderNotes();
  }
  async function saveNote(text) {
    if (!needSession($('noteMsg'))) return;
    try {
      if (!String(text || '').trim()) {
        notes = (await apiJson(`/api/admin/sessions/${sessionId}/notes`, { method: 'DELETE' })).notes || [];
        renderNotes();
        msg($('noteMsg'), 'ok', 'Taken off the board.', '');
        return;
      }
      const out = await postJson(`/api/admin/sessions/${sessionId}/notes`, { text });
      notes = out.notes || [];
      renderNotes();
      $('fBoardNote').value = '';
      msg($('noteMsg'), 'ok', 'On the board.', 'The board picks it up within a few seconds.');
    } catch (err) { msg($('noteMsg'), 'err', err.message); }
  }
  $('btnSaveNote').onclick = () => saveNote($('fBoardNote').value);
  $('btnClearNote').onclick = () => { if (!notes.length || confirm('Take every note off the board?')) { $('fBoardNote').value = ''; saveNote(''); } };
  $('fBoardNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNote($('fBoardNote').value); });

  /* ------------------------------------------------------- SOS from the floor
     A counter pressed the button. This has to reach a supervisor who is looking
     at something else, so it goes above the page rather than into a card, and
     the first one makes a noise. "I am on it" is the part that matters to the
     person who pressed it: their gun says somebody has seen it. */
  let sosSeen = new Set();
  let sosSounded = false;

  async function refreshAlerts() {
    const data = await apiJson(`/api/admin/sessions/${sessionId}/alerts`);
    const live = (data.alerts || []).filter((a) => a.status !== 'closed');

    /* A new one makes a noise once. Browsers only allow that after somebody has
       clicked something on the page, which a supervisor always has. */
    const fresh = live.filter((a) => !sosSeen.has(a.id));
    if (fresh.length && sosSounded) sosNoise();
    sosSounded = true;
    sosSeen = new Set(live.map((a) => a.id));

    const box = $('sosAlert');
    box.innerHTML = '';
    box.hidden = !live.length;
    for (const a of live) box.appendChild(sosBanner(a));
    api.subCount('alerts', live.length || 0);   // the badge on the Alerts tab, until every SOS is closed

    table($('sosTable'),
      [{ label: 'When' }, { label: 'Team' }, { label: 'What' }, { label: 'Where' }, { label: 'Scanner' },
        { label: 'State' }, { label: 'Sent on' }, { label: '' }],
      data.alerts || [],
      (a) => {
        const tr = document.createElement('tr');
        tr.append(cell(new Date(a.created_at).toLocaleString()), cell(a.team || '—'),
          cell(a.detail ? `${a.reason} — ${a.detail}` : a.reason, 'wrap'),
          cell([a.aisle, a.bin].filter(Boolean).join(' · ') || '—'), cell(a.device_id || '—'));
        const st = document.createElement('td');
        st.appendChild(tag(a.status === 'closed' ? 'CLOSED' : a.status === 'seen' ? 'ON IT' : 'OPEN'));
        if (a.status === 'seen' && a.seen_by) st.append(` ${a.seen_by}`);
        if (a.status === 'closed' && a.outcome) st.append(` · ${a.outcome}`);
        tr.append(st, cell(a.sent_to || '—', 'wrap'));
        const act = document.createElement('td');
        if (a.status !== 'closed') {
          if (a.status === 'open') act.appendChild(button('I am on it', 'sm primary', () => seeAlert(a.id)));
          act.appendChild(button('Close', 'sm', () => closeAlert(a.id)));
        }
        tr.appendChild(act);
        return tr;
      },
      'Nothing raised on this count — which is the way it should be.');
  }

  function sosBanner(a) {
    const el = document.createElement('div');
    el.className = 'one' + (a.status === 'seen' ? ' seen' : '');
    const grow = document.createElement('div');
    grow.className = 'grow';
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `SOS · team ${a.team || '?'} — ${a.reason}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = [
      [a.aisle && `aisle ${a.aisle}`, a.bin && `last bin ${a.bin}`].filter(Boolean).join(' · '),
      a.device_id, (a.names || a.employees || []).join(', '),
      new Date(a.created_at).toLocaleTimeString(),
      a.status === 'seen' && a.seen_by ? `${a.seen_by} is on it` : '',
      a.sent_to === 'teams' ? 'sent to Teams' : a.sent_to && a.sent_to !== 'teams off' ? a.sent_to : '',
    ].filter(Boolean).join(' · ');
    grow.append(what, who);
    if (a.detail) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = `“${a.detail}”`;
      grow.appendChild(note);
    }
    const acts = document.createElement('div');
    acts.className = 'acts';
    if (a.status === 'open') acts.appendChild(button('I am on it', 'primary', () => seeAlert(a.id)));
    acts.appendChild(button('Close', '', () => closeAlert(a.id)));
    el.append(grow, acts);
    return el;
  }

  /* Two notes, a beat apart: enough to look up, not enough to make somebody turn
     the sound off - which would defeat the whole thing. */
  function sosNoise() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      for (const [at, hz] of [[0, 880], [0.28, 1174]]) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, ac.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.28, ac.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + at + 0.24);
        osc.connect(gain).connect(ac.destination);
        osc.start(ac.currentTime + at);
        osc.stop(ac.currentTime + at + 0.26);
      }
    } catch { /* a sound is a nicety; the red bar is the alert */ }
  }

  async function seeAlert(id) {
    try {
      await postJson(`/api/admin/sessions/${sessionId}/alerts/${id}/seen`, {});
      await refreshAlerts();
    } catch (err) { msg($('sosAdminMsg'), 'err', err.message); }
  }

  async function closeAlert(id) {
    const outcome = prompt('Close this SOS — what happened? (optional)') ?? null;
    if (outcome === null) return;                    // canceled: leave it open
    try {
      await postJson(`/api/admin/sessions/${sessionId}/alerts/${id}/close`, { outcome });
      await refreshAlerts();
    } catch (err) { msg($('sosAdminMsg'), 'err', err.message); }
  }

  /* ------------------------------------------------- a word to the floor
     Addressed to one team or all of them, and the table says who has read it -
     a supervisor should not have to walk out and ask. */
  async function refreshMessages() {
    const [data, prog] = await Promise.all([
      apiJson(`/api/admin/sessions/${sessionId}/messages`),
      apiJson(`/api/admin/sessions/${sessionId}/progress`),
    ]);
    // the teams to choose from are the ones signed on, plus any with a plan
    const teams = [...new Set([
      ...(prog.signedOn || []).map((t) => t.team),
      ...(prog.byTeam || []).map((t) => t.team),
    ])].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    const sel = $('fMsgTeam');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Every team</option>'
      + teams.map((t) => `<option value="${t}">Team ${t}</option>`).join('');
    sel.value = teams.includes(keep) ? keep : '';

    table($('msgTable'),
      [{ label: 'Sent' }, { label: 'To' }, { label: 'Message' }, { label: 'Read by' }, { label: '' }],
      data.messages || [],
      (m) => {
        const tr = document.createElement('tr');
        tr.append(cell(new Date(m.created_at).toLocaleTimeString()), cell(m.audience));
        const body = document.createElement('td');
        body.className = 'wrap';
        body.append(m.body);
        if (m.urgent) { const t = tag('MISSING'); t.textContent = 'urgent'; t.style.marginLeft = '6px'; body.appendChild(t); }
        if (m.cleared_at) { const t = tag('supervisor'); t.textContent = 'taken down'; t.style.marginLeft = '6px'; body.appendChild(t); }
        tr.appendChild(body);
        const read = document.createElement('td');
        read.append(`${m.acks} of ${m.sent_to || 0}`);
        if (m.ack_devices) { read.append(' '); const t = tag('MATCH'); t.textContent = m.ack_devices; read.appendChild(t); }
        tr.appendChild(read);
        const act = document.createElement('td');
        if (!m.cleared_at) {
          const b = document.createElement('button');
          b.className = 'sm ghost';
          b.textContent = 'Take it down';
          b.onclick = async () => {
            try { await apiJson(`/api/admin/sessions/${sessionId}/messages/${m.id}`, { method: 'DELETE' }); await refreshMessages(); }
            catch (err) { msg($('msgMsg'), 'err', err.message); }
          };
          act.appendChild(b);
        }
        tr.appendChild(act);
        return tr;
      }, 'Nothing sent to the floor yet.');
  }

  $('btnSendMsg').onclick = async () => {
    if (!needSession($('msgMsg'))) return;
    const body = $('fMsgBody').value.trim();
    if (!body) { msg($('msgMsg'), 'err', 'Type the message first'); return; }
    try {
      const sent = await postJson(`/api/admin/sessions/${sessionId}/messages`, {
        team: $('fMsgTeam').value, body, urgent: $('fMsgUrgent').checked,
      });
      $('fMsgBody').value = '';
      $('fMsgUrgent').checked = false;
      msg($('msgMsg'), 'ok', `Sent to ${sent.team ? 'team ' + sent.team : 'every team'}.`,
        'It is on their scanners within about twenty seconds, and stays until somebody taps Got it.');
      await refreshMessages();
    } catch (err) { msg($('msgMsg'), 'err', err.message); }
  };
  $('fMsgBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSendMsg').click(); });

  // The map is the expensive one and it is usually off-screen, so redraw it when
  // its tab is opened rather than every thirty seconds behind the user's back.
  document.addEventListener('subshow', (e) => {
    if (!sessionId) return;
    for (const f of paneJobs()[e.detail] || []) if (tab(e.detail)) Promise.resolve().then(f).catch(() => {});
  });

  const download = (path, filename) =>
    (needSession($('palletNote')) ? api.download(path, filename) : Promise.resolve())
      .catch((err) => msg($('palletNote'), 'err', err.message));

  /* ------------------------------------------------------------ wiring */
  $('fOnlyExceptions').onchange = renderPallets;
  $('fPalletSource').onchange = refreshPallets;
  for (const id of ['fHideMissing', 'fPalletStatus', 'fLotExpOnly']) $(id).onchange = renderPallets;
  for (const id of ['fPalletBin', 'fPalletTeam', 'fPalletFind']) $(id).oninput = renderPallets;
  $('btnPalletClear').onclick = () => {
    $('fOnlyExceptions').checked = true; $('fHideMissing').checked = false; $('fPalletStatus').value = ''; $('fLotExpOnly').checked = false;
    $('fPalletBin').value = ''; $('fPalletTeam').value = ''; $('fPalletFind').value = '';
    renderPallets();
  };
  $('fAdjSource').onchange = () => refreshAdjustments().catch(() => {});
  $('fPalletLimit').onchange = () => { try { sessionStorage.setItem('palletLimit', $('fPalletLimit').value); } catch { /* private window */ } renderPallets(); };
  try { const saved = sessionStorage.getItem('palletLimit'); if (saved) $('fPalletLimit').value = saved; } catch { /* private window */ }

  async function queueAisles(force) {
    const r = await postJson(`/api/admin/sessions/${sessionId}/assignments`,
      { team: $('fAssignTeam').value, aisles: $('fAssignAisles').value, levels: $('fAssignLevels').value, direction: $('fAssignFrom').value, force });
    return r;
  }

  /* the plan as a file: out, and back in */
  $('btnPlanExport').onclick = () => {
    if (!needSession($('planFileMsg'))) return;
    const s = currentSession();
    api.download(`/api/admin/sessions/${sessionId}/export/plan.csv`, `plan-${String((s && s.name) || 'count').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'count'}.csv`)
      .catch((err) => msg($('planFileMsg'), 'err', err.message));
  };
  $('btnPlanUpload').onclick = async () => {
    if (!needSession($('planFileMsg'))) return;
    const file = $('fPlanFile').files[0];
    if (!file) { msg($('planFileMsg'), 'err', 'Choose a plan file first', 'A CSV or Excel file: Team, Aisle, Levels, and Start if you use it. ⬇ Sample plan shows the layout.'); return; }
    const replace = $('fPlanFileReplace').checked;
    if (replace && !confirm('Replace what is queued? Every aisle still queued or being counted comes off first; finished aisles stay.')) return;
    msg($('planFileMsg'), 'warn', `Reading ${file.name}…`);
    try {
      const stats = await apiJson(`/api/admin/sessions/${sessionId}/plan?replace=${replace ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await window.appUi.fileToCsv(file) });
      const started = (stats.activated || []).map((a) => `team ${a.team} in ${a.aisle}`);
      msg($('planFileMsg'), stats.skipped ? 'warn' : 'ok', `${stats.planned.toLocaleString()} aisle assignment${stats.planned === 1 ? '' : 's'} from ${file.name}${replace ? ', replacing what was queued' : ''}`,
        [started.length ? `started ${started.join('; ')}` : '',
          stats.skipped ? `${stats.skipped} row${stats.skipped === 1 ? '' : 's'} skipped${stats.skippedNoLevels ? ` (${stats.skippedNoLevels} with no levels)` : ''} — a missing team or aisle, an aisle not on this count's bin list, or no levels` : ''].filter(Boolean).join(' · '));
      $('fPlanFile').value = '';
      await refreshAll();
    } catch (err) { msg($('planFileMsg'), 'err', 'Upload failed', err.message); }
  };
  $('btnPlanUpload').disabled = !api.can('assign');

  $('btnAssign').onclick = async () => {
    if (!needSession($('assignMsg'))) return;
    if (!$('fAssignLevels').value.trim()) { msg($('assignMsg'), 'err', 'Levels are required', 'Which levels does this team count? e.g. A-C, D-F, or A-F for every level.'); $('fAssignLevels').focus(); return; }
    try {
      let r;
      try {
        r = await queueAisles(false);
      } catch (err) {
        // the team cannot reach those levels: say so, and let a supervisor insist
        if (!/cannot reach level/.test(err.message)) throw err;
        if (!confirm(`${err.message}\n\nAssign it anyway?`)) { msg($('assignMsg'), 'err', err.message, 'Nothing queued. Change the levels, or put someone with the right equipment on the team (Teams & crew).'); return; }
        r = await queueAisles(true);
      }
      const parts = [];
      if (r.added.length) parts.push(`queued ${r.added.join(', ')}`);
      if (r.activated.length) parts.push(`started ${r.activated.map((a) => `team ${a.team} in ${a.aisle}${a.levels ? ' (' + a.levels + ')' : ''}`).join('; ')}`);
      msg($('assignMsg'), r.skipped.length ? 'warn' : 'ok', parts.join(' · ') || 'Nothing to queue',
        r.skipped.map((s) => `${s.aisle}: ${s.reason}`).join(' · '));
      $('fAssignAisles').value = '';
      await refreshAll();
    } catch (err) { msg($('assignMsg'), 'err', err.message); }
  };

  $('btnFindLot').onclick = async () => {
    if (!needSession($('lotMsg'))) return;
    const q = $('fLotSearch').value.trim();
    if (!q) return msg($('lotMsg'), 'err', 'Type a lot code first');
    try {
      const r = await apiJson(`/api/admin/sessions/${sessionId}/lot?q=${encodeURIComponent(q)}`);
      const rows = [
        ...r.counted.map((x) => ({ ...x, where: 'counted' })),
        ...r.expected.filter((e) => !r.counted.some((c) => c.pallet_id === e.pallet_id))
          .map((x) => ({ ...x, where: 'on the report, not counted', location_code: x.expected_location, qty: x.expected_qty })),
      ];
      msg($('lotMsg'), rows.length ? 'ok' : 'warn',
        rows.length ? `${r.counted.length} counted, ${r.expected.length} on the report` : `Nothing matches "${q}"`,
        rows.length ? 'Counted rows are where it actually is now.' : 'Check the code, or whether this count records lot codes at all.');
      table($('lotTable'),
        [{ label: 'Pallet' }, { label: 'Lot' }, { label: 'Expiry' }, { label: 'Qty', num: true }, { label: 'Bin' }, { label: 'Aisle' }, { label: 'Item', }, { label: 'Team' }, { label: 'State' }],
        rows,
        (x) => {
          const tr = document.createElement('tr');
          tr.append(cell(x.pallet_id), cell(x.lot || ''), cell(x.expiry || ''), cell(x.qty ?? '', 'num'),
            cell(x.location_code || ''), cell(x.aisle || ''), cell([x.sku, x.description].filter(Boolean).join(' — '), 'wrap'), cell(x.team || ''));
          const td = document.createElement('td');
          td.appendChild(tag(x.where === 'counted' ? 'done' : 'queued'));
          td.append(' ' + x.where);
          tr.appendChild(td);
          return tr;
        }, 'Nothing found.');
    } catch (err) { msg($('lotMsg'), 'err', err.message); }
  };
  $('fLotSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnFindLot').click(); });

  $('btnExportPallets').onclick = () => download(`/api/admin/sessions/${sessionId}/export/pallets.csv`, `pallets-session-${sessionId}.csv`);
  /* Everything about this count, readable: one sheet per table, plain headings,
     Yes and No, times on the warehouse clock. */
  $('btnExportAll').onclick = async () => {
    if (!sessionId) return;
    const b = $('btnExportAll');
    const was = b.textContent;
    b.disabled = true;
    b.textContent = 'Building the workbook…';
    try {
      const [data, XLSX] = await Promise.all([apiJson(`/api/admin/sessions/${sessionId}/export/everything`), window.appUi.loadXlsx()]);
      writeWorkbook(XLSX, data);
    } catch (err) {
      alert('Could not build the export: ' + err.message);
    } finally {
      b.disabled = false;
      b.textContent = was;
    }
  };
  $('btnExportCounts').onclick = () => download(`/api/admin/sessions/${sessionId}/export/counts.csv`, `counts-session-${sessionId}.csv`);
  $('btnExportExceptions').onclick = () => download(`/api/admin/sessions/${sessionId}/export/exceptions.csv`, `exceptions-session-${sessionId}.csv`);
  $('btnExportUncounted').onclick = () => download(`/api/admin/sessions/${sessionId}/export/uncounted.csv`, `uncounted-bins-session-${sessionId}.csv`);

  /* ------------------------------------------------------------ boot */
  async function loadLayouts() { layouts = await apiJson('/api/admin/layouts'); }
  /* The buttons a login may not press are switched off and say why; the
     server refuses the rest. */
  function applyAccess() {
    const off = (id, key, what) => {
      const b = $(id);
      if (!b) return;
      const ok = api.can(key);
      b.disabled = !ok;
      b.title = ok ? '' : `Not able to: this login may not ${what}. An admin can allow it under Settings → Logins → Supervisor logins.`;
    };
    off('btnSendMsg', 'messages', 'message the floor');
    off('btnAssign', 'assign', 'queue aisles');
    off('btnAutoPlan', 'assign', 'queue aisles');
    off('btnApprove', 'approve', 'approve adjustments');
    off('btnReject', 'approve', 'approve adjustments');
    off('btnSaveNote', 'assign', 'change the board note');
    off('btnExportAll', 'export', 'download exports');
    off('btnFinalReport', 'export', 'file the final report');
  }
  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    applyAccess();
    (async () => { await loadLayouts(); await loadSessions(); })().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && sessionId) refreshAll().catch(() => {}); }, 30000);
  /* An SOS cannot wait for the half-minute refresh: somebody is standing in an
     aisle waiting to hear that anybody at all has seen it. */
  setInterval(() => { if (api.token && sessionId) refreshAlerts().catch(() => {}); }, 8000);
  setInterval(() => { if (api.token && sessionId) refreshClocks().catch(() => {}); }, 15000);
})();
