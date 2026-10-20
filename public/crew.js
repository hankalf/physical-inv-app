/* The crew board: who is on which team, by shift, on a wall screen. No
   sign-in, no controls. It polls, never writes, and keeps the last list on
   screen if the server goes away. ?shift=1 or ?shift=2 pins it to one shift;
   ?every=30 sets the poll in seconds. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const ONLY = ['1', '2'].includes(q.get('shift') || '') ? q.get('shift') : '';
  const SESSION = q.get('session') || '';
  const EVERY = Math.max(5, Number(q.get('every') || 30)) * 1000;
  let boardBrand = '';
  let lastGood = 0;
  let siteTime = '';         // the warehouse's clock, from the server: what "on now" was judged by

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /** How long since the team last scanned, in words. */
  const since = (iso) => {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  };
  const levels = (l) => (!l ? '' : l.length === 1 ? `level ${l}` : [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1) ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`);

  function teamCard(t) {
    const box = el('div', 'team');
    box.dataset.team = t.name;
    const n = t.now;
    const cls = n.stopped ? 'stopped' : n.state === 'scanning' ? 'live' : n.state === 'not signed on' ? 'off' : 'done';
    box.classList.add(cls);
    const th = el('div', 'th');
    th.append(el('b', '', `Team ${t.name}`));
    if (t.shiftInferred) th.append(el('span', 'inf', 'shift from its people'));
    const pill = el('span', 'st ' + cls, n.state === 'stopped scanning' && n.quietMinutes != null ? `Stopped scanning · ${n.quietMinutes} min` : n.state[0].toUpperCase() + n.state.slice(1));
    th.append(pill);
    box.append(th);
    /* where it is on the count, and when it last scanned */
    const where = el('div', 'where');
    if (n.aisle) where.append(el('b', '', `Aisle ${n.aisle}`), document.createTextNode(`${n.levels ? ' · ' + levels(n.levels) : ''}${n.fromFarEnd ? ' · from the far end' : ''}`));
    else if (n.state === 'not signed on') where.append(document.createTextNode('No aisle yet'));
    else where.append(document.createTextNode('No aisle assigned'));
    if (n.lastScan) where.append(el('span', 'last', `last scan ${since(n.lastScan)}${n.lastBin ? ' · ' + n.lastBin : ''}`));
    if (n.next) where.append(el('span', 'next', `next ${n.next.aisle}${n.next.more ? ` +${n.next.more}` : ''}`));
    box.append(where);
    if (t.notes) box.append(el('div', 'notes', t.notes));
    const ul = el('ul');
    for (const m of t.members) {
      const li = el('li');
      li.append(el('span', 'nm', m.name));
      ul.append(li);
    }
    for (const o of t.open) ul.append(el('li', 'open', ` open seat${o.role ? ` · ${o.role}` : ''}${o.dept ? ` · ${o.dept}` : ''}`));
    if (!t.members.length && !t.open.length) ul.append(el('li', 'open', ' nobody assigned yet'));
    box.append(ul);
    return box;
  }

  function shiftPanel(s) {
    const box = el('section', 'shift' + (s.on ? ' on' : '') + (s.key ? '' : ' unset'));
    box.dataset.shift = s.key;
    const head = el('div', 'sh');
    head.append(el('h2', '', s.label));
    if (s.hours) head.append(el('span', 'hours', s.hours));
    const people = s.teams.reduce((n, t) => n + t.members.length, 0);
    head.append(el('span', 'count', `${s.teams.length} team${s.teams.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'}`));
    if (s.on) head.append(el('span', 'onnow', 'On now'));
    box.append(head);
    const grid = el('div', 'teams');
    for (const t of s.teams) grid.append(teamCard(t));
    if (!s.teams.length) grid.append(el('div', 'empty', s.key ? `No teams on the ${s.label.toLowerCase()} yet` : ''));
    box.append(grid);
    return box;
  }

  function paint(d) {
    const now = $('bNow');
    now.innerHTML = '';
    now.append(el('b', '', d.now.shift ? 'On now: ' : ''), document.createTextNode(d.now.label + (d.now.until ? ` · until ${d.now.until}` : '')));
    $('bSession').textContent = d.session ? d.session.name : 'No open count';
    const wrap = $('bShifts');
    wrap.innerHTML = '';
    const shown = d.shifts.filter((s) => (ONLY ? s.key === ONLY : s.key || s.teams.length));
    wrap.style.setProperty('--cols', String(Math.max(1, Math.min(2, shown.filter((s) => s.key).length))));
    for (const s of shown) wrap.append(shiftPanel(s));
    siteTime = d.now.time || '';
    const on = d.shifts.find((s) => s.on);
    document.title = `${on ? on.label + ' · ' : ''}Crew board${boardBrand ? ' — ' + boardBrand : ''}`;
  }

  function clock(ok) {
    const now = new Date();
    const c = $('bClock');
    c.innerHTML = '';
    c.append(el('b', '', ok && siteTime ? siteTime : now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    if (!ok) {
      const mins = Math.floor((Date.now() - lastGood) / 60000);
      c.append(el('span', 'stale-warn', lastGood ? `  · not updating (${mins || 1} min)` : '  · cannot reach the server'));
    }
  }

  async function tick() {
    try {
      if (!boardBrand) fetch('/api/branding', { cache: 'no-cache' }).then((r) => r.json()).then((b) => { boardBrand = b.name || ''; $('bSite').textContent = [b.name, b.place].filter(Boolean).join(' · '); }).catch(() => {});
      const res = await fetch('/api/board/crew' + (SESSION ? `?session=${encodeURIComponent(SESSION)}` : ''), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      paint(await res.json());
      lastGood = Date.now();
      clock(true);
    } catch {
      clock(false);          // the last list stays up rather than a blank wall
    }
  }

  tick();
  setInterval(tick, EVERY);
  setInterval(() => clock(Date.now() - lastGood < EVERY * 3), 30000);
})();
