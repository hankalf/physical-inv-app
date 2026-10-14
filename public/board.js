/* The office board: progress on a wall screen, no sign-in, no controls.
   It polls, it never writes, and it survives the server going away. */
(() => {
  'use strict';
  let boardBrand = '';

  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const sessionParam = q.get('session') || '';
  const EVERY = Math.max(5, Number(q.get('every') || 15)) * 1000;
  const n = (v) => Number(v || 0).toLocaleString();

  let lastGood = 0;
  let boardClock = null;      // the clock on the count, ticked here between polls

  const span = (ms) => {
    if (!(ms >= 0)) return '—';
    const m = Math.floor(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  };
  const at = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  };

  /* The clock on the count: from the first sign-on, the downtime (nobody on
     the count scanning for longer than the site's stopped-scanning limit)
     taken out, the pace over the last half hour, and when the bins left will
     be done at that pace. Time on the clock and downtime tick every second. */
  function clockRow(c) {
    boardClock = c && c.started ? c : null;
    $('bClockRow').hidden = !boardClock;
    if (!boardClock) return;
    $('bcElapsedL').textContent = c.running ? `On the clock · started ${at(c.started)}` : `Took · ${at(c.started)} to ${at(c.ended)}`;
    const r = c.recent;
    if (c.running && r && r.binsPerHour != null) {
      $('bcPace').textContent = `${n(r.binsPerHour)} bins / h`;
      $('bcPaceL').textContent = `Pace, last ${r.minutes} min · average ${n(c.binsPerHour)} bins / h, ${n(c.linesPerHour)} lines / h`;
    } else {
      $('bcPace').textContent = c.binsPerHour != null ? `${n(c.binsPerHour)} bins / h` : '—';
      $('bcPaceL').textContent = c.linesPerHour != null ? `Pace, over the counting time · ${n(c.linesPerHour)} lines / h` : 'Pace · nothing counted yet';
    }
    if (!c.running) { $('bcEta').textContent = at(c.ended); $('bcEtaL').textContent = 'Finished'; }
    else if (!c.binsLeft) { $('bcEta').textContent = 'now'; $('bcEtaL').textContent = 'Done about · every bin has a count'; }
    else if (c.finishAt) { $('bcEta').textContent = at(c.finishAt); $('bcEtaL').textContent = `Done about · ${n(c.binsLeft)} bins left at ${c.finishBasis === 'recent' ? 'the pace of the last half hour' : 'the average pace'}`; }
    else { $('bcEta').textContent = '—'; $('bcEtaL').textContent = `Done about · ${n(c.binsLeft)} bins left, no pace yet`; }
    tickClock();
  }
  function tickClock() {
    const c = boardClock;
    if (!c) return;
    const now = Date.now();
    let elapsed = c.elapsedMs;
    let down = c.downtimeMs;
    let quiet = null;
    if (c.running) {
      elapsed = Math.max(0, now - Date.parse(c.started));
      const q = Math.max(0, now - Date.parse(c.lastActivity));
      const isDown = q > c.gapMinutes * 60000;
      down = c.downtimeClosedMs + (isDown ? q : 0);
      if (isDown) quiet = q;
    }
    $('bcElapsed').textContent = span(elapsed);
    $('bcDown').textContent = span(down);
    $('bcCounting').textContent = span(Math.max(0, elapsed - down));
    const over = c.spells.filter((x) => !x.open).length;
    $('bcDownL').innerHTML = '';
    $('bcDownL').append(document.createTextNode(`Downtime · ${over ? `${over} quiet spell${over === 1 ? '' : 's'} over ${c.gapMinutes} min` : `quiet spells over ${c.gapMinutes} min`}`));
    if (quiet != null) { const w = document.createElement('span'); w.className = 'now'; w.textContent = ` · quiet now, ${span(quiet)}`; $('bcDownL').appendChild(w); }
  }

  const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; };

  /** How long since this team last scanned, in words a manager can act on. */
  function since(iso) {
    if (!iso) return { text: 'not started', cls: 'idle' };
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return { text: 'just now', cls: 'live' };
    if (mins < 6) return { text: `${mins} min ago`, cls: 'live' };
    if (mins < 20) return { text: `${mins} min ago`, cls: 'stale' };
    if (mins < 120) return { text: `${mins} min ago`, cls: 'idle' };
    return { text: `${Math.floor(mins / 60)} h ago`, cls: 'idle' };
  }

  function tiles(d) {
    const box = $('bTiles');
    box.innerHTML = '';
    const items = [
      [n(d.lines), 'Count lines', ''],
      [`${n(d.pallets.found)} / ${n(d.pallets.total)}`, 'Listed pallets found', ''],
      [n(d.teams.filter((t) => t.lines > 0).length), 'Teams counting', ''],
      [n(d.emptyBins), 'Bins checked empty', ''],
      [n(d.flagged), 'Flagged lines', d.flagged ? 'warn' : ''],
      [n(d.recounts.open), 'Second counts open', d.recounts.open ? 'err' : ''],
    ];
    for (const [v, label, cls] of items) {
      const el = document.createElement('div');
      el.className = 'stat' + (cls ? ' ' + cls : '');
      const a = document.createElement('div'); a.className = 'n'; a.textContent = v;
      const b = document.createElement('div'); b.className = 'l'; b.textContent = label;
      el.append(a, b);
      box.appendChild(el);
    }
  }

  function teams(d) {
    const t = $('bTeams');
    t.innerHTML = '';
    const head = document.createElement('tr');
    const paces = new Map(((d.clock && d.clock.teams) || []).map((k) => [String(k.team), k]));
    for (const [label, cls] of [['Team', ''], ['Crew', 'num'], ['Guns', 'num'], ['Aisle', ''], ['Bins', 'num'], ['Lines', 'num'], ['Lines / h', 'num'], ['Downtime', ''], ['Last scan', '']]) {
      const th = document.createElement('th');
      th.textContent = label;
      if (cls) th.className = cls;
      head.appendChild(th);
    }
    const thead = document.createElement('thead'); thead.appendChild(head);
    const tbody = document.createElement('tbody');
    if (!d.teams.length) {
      const tr = document.createElement('tr');
      const td = cell('Nobody has signed on yet.');
      td.colSpan = 9; td.className = 'muted';
      tr.appendChild(td); tbody.appendChild(tr);
    }
    for (const row of d.teams) {
      const tr = document.createElement('tr');
      const tdTeam = document.createElement('td');
      tdTeam.className = 'team-no';
      const s = since(row.lastScan);
      const dot = document.createElement('span');
      dot.className = 'dot ' + s.cls;
      tdTeam.append(dot, document.createTextNode(row.team));
      tr.appendChild(tdTeam);
      const k = paces.get(String(row.team)) || null;
      const down = cell(k && k.started ? span(k.downtimeMs) : '—');
      if (k && k.quietMinutes != null) down.className = 'stale-warn';
      tr.append(cell(row.crew || '—', 'num'), cell(row.scanners || '—', 'num'), cell(row.aisle || '—'),
                cell(n(row.bins), 'num'), cell(n(row.lines), 'num'), cell(k && k.linesPerHour != null ? n(k.linesPerHour) : '—', 'num'), down);
      const last = cell(s.text);
      if (s.cls === 'stale') last.className = 'stale-warn';
      tr.appendChild(last);
      tbody.appendChild(tr);
    }
    t.append(thead, tbody);
  }

  function aisles(d) {
    const grid = $('bAisleGrid');
    grid.innerHTML = '';
    $('bAisleHead').textContent = d.session && d.session.mode === 'cycle'
      ? 'Aisles on the list' : `Aisles — ${d.aislesDone} of ${d.aislesTotal} complete`;
    if (!d.aisles.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No bin list uploaded for this count yet.';
      grid.appendChild(e);
      return;
    }
    for (const a of d.aisles) {
      const pc = a.bins ? Math.round((a.counted / a.bins) * 100) : 0;
      const el = document.createElement('div');
      el.className = 'ai' + (a.done ? ' done' : a.active ? ' active' : '');
      const code = document.createElement('div'); code.className = 'code'; code.textContent = a.aisle;
      const p = document.createElement('div'); p.className = 'pc'; p.textContent = pc + '%';
      const mini = document.createElement('div'); mini.className = 'mini';
      const fill = document.createElement('i'); fill.style.width = pc + '%';
      mini.appendChild(fill);
      el.append(code, p, mini);
      if (a.active) {
        const who = document.createElement('div');
        who.className = 'team';
        who.textContent = 'T' + a.active;
        el.appendChild(who);
      }
      el.title = `${a.zone ? a.zone + ' — ' : ''}Aisle ${a.aisle}: ${n(a.counted)} of ${n(a.bins)} bins`;
      grid.appendChild(el);
    }
  }

  function paint(d) {
    if (!d.session) {
      $('bSession').textContent = 'no count session yet';
      $('bOf').textContent = 'Create one on the dashboard.';
      return;
    }
    document.title = `${d.pct}% — ${d.session.name}${boardBrand ? ' — ' + boardBrand : ''}`;
    $('bSession').textContent = `${d.session.name}${d.session.mode === 'cycle' ? ' · cycle count' : ''}${d.session.trial ? ' · TRIAL RUN' : ''}`;
    /* The note from the office, above everything else: breaks, lunch, a dock
       nobody can get to. Gone entirely when there is nothing to say, rather
       than an empty box taking room from the progress bar. */
    const notes = d.notes || (d.note ? [{ text: d.note, by: d.noteBy, at: d.noteAt }] : []);
    $('bNote').hidden = !notes.length;
    const txt = $('bNoteText');
    txt.replaceChildren(...notes.map((x) => { const l = document.createElement('div'); l.className = 'line'; l.textContent = x.text; return l; }));
    const last = notes[notes.length - 1];
    $('bNoteWho').textContent = last && last.at
      ? `${last.by ? last.by + ' · ' : ''}${new Date(last.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : '';
    $('bPct').textContent = d.pct;
    $('bOf').textContent = `${n(d.pallets.found)} of ${n(d.pallets.total)} listed pallets found`;
    $('bBar').style.width = d.pct + '%';
    $('bBarText').textContent = `${n(d.bins.counted)} of ${n(d.bins.total)} bins`;
    $('bBins').textContent = `${n(d.bins.counted)} / ${n(d.bins.total)}`;
    const ap = d.aislesTotal ? Math.round((d.aislesDone / d.aislesTotal) * 100) : 0;
    $('bAisleBar').style.width = ap + '%';
    $('bAisles').textContent = `${d.aislesDone} / ${d.aislesTotal} (${ap}%)`;
    clockRow(d.clock);
    tiles(d);
    teams(d);
    aisles(d);
  }

  function clock(ok) {
    const now = new Date();
    const el = $('bClock');
    el.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.append(b);
    if (!ok) {
      const mins = Math.floor((Date.now() - lastGood) / 60000);
      const w = document.createElement('span');
      w.className = 'stale-warn';
      w.textContent = lastGood ? `  · not updating (${mins || 1} min)` : '  · cannot reach the server';
      el.appendChild(w);
    }
  }

  async function tick() {
    try {
      if (!boardBrand) fetch('/api/branding', { cache: 'no-cache' }).then((r) => r.json()).then((b) => { boardBrand = b.name || ''; const h = document.getElementById('bSite'); if (h) h.textContent = [b.name, b.place].filter(Boolean).join(' · '); }).catch(() => {});
      const res = await fetch('/api/board' + (sessionParam ? `?session=${encodeURIComponent(sessionParam)}` : ''), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      paint(await res.json());
      lastGood = Date.now();
      clock(true);
    } catch {
      clock(false);          // keep the last good numbers on screen rather than blanking
    }
  }

  tick();
  setInterval(tick, EVERY);
  setInterval(() => clock(Date.now() - lastGood < EVERY * 3), 30000);
  setInterval(tickClock, 1000);
})();
