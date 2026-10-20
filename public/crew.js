/* The crew board: who is on which team, by shift, on a wall screen. No
   sign-in, no controls. It polls, never writes, and keeps the last list on
   screen if the server goes away.

   One shift at a time: the one on now by the warehouse's clock (between
   shifts, the one coming in next), or the one an admin fixed under Settings →
   Site & systems → Crew board - which also says what each team's card carries
   and whether the list scrolls by itself, and how fast. On the address,
   ?shift=1 or ?shift=2 pins this screen to one shift whatever is set,
   ?scroll=0 stops the scrolling here alone, ?every=30 sets the poll in
   seconds, ?session=12 reads another count. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const ONLY = ['1', '2'].includes(q.get('shift') || '') ? q.get('shift') : '';
  const SESSION = q.get('session') || '';
  const EVERY = Math.max(5, Number(q.get('every') || 30)) * 1000;
  const NO_SCROLL = q.get('scroll') === '0';
  let boardBrand = '';
  let lastGood = 0;
  let siteTime = '';         // the warehouse's clock, from the server: what "on now" was judged by
  let config = { shift: 'auto', show: { members: true, openSeats: true, notes: true, where: true, lastScan: true, count: true }, scroll: { on: true, speed: 'normal', pause: 6 }, pxPerSecond: 36 };

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  /** How long since the team last scanned, in words. */
  const since = (iso) => {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  };
  const levels = (l) => (!l ? '' : l.length === 1 ? `level ${l}` : [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1) ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`);

  function teamCard(t, { unset = false } = {}) {
    const show = config.show;
    const box = el('div', 'team');
    box.dataset.team = t.name;
    const n = t.now;
    const cls = n.stopped ? 'stopped' : n.state === 'scanning' ? 'live' : n.state === 'not signed on' ? 'off' : 'done';
    if (show.where) box.classList.add(cls);
    if (unset) box.classList.add('unset');
    const th = el('div', 'th');
    th.append(el('b', '', `Team ${t.name}`));
    if (unset) th.append(el('span', 'inf', 'shift not set'));
    else if (t.shiftInferred) th.append(el('span', 'inf', 'shift from its people'));
    if (show.where) {
      const pill = el('span', 'st ' + cls, n.state === 'stopped scanning' && n.quietMinutes != null ? `Stopped scanning · ${n.quietMinutes} min` : n.state[0].toUpperCase() + n.state.slice(1));
      th.append(pill);
    }
    box.append(th);
    /* where it is on the count, and when it last scanned */
    if (show.where || show.lastScan) {
      const where = el('div', 'where');
      if (show.where) {
        if (n.aisle) {
          // the aisle and its levels stay together on one line; the last scan and next aisle wrap after it
          const pos = el('span', 'pos');
          pos.append(el('b', '', `Aisle ${n.aisle}`), document.createTextNode(`${n.levels ? ' · ' + levels(n.levels) : ''}${n.fromFarEnd ? ' · from the far end' : ''}`));
          where.append(pos);
        }
        else if (n.state === 'not signed on') where.append(document.createTextNode('No aisle yet'));
        else where.append(document.createTextNode('No aisle assigned'));
      }
      if (show.lastScan) {
        if (n.lastScan) where.append(el('span', 'last', `last scan ${since(n.lastScan)}${n.lastBin ? ' · ' + n.lastBin : ''}`));
        if (n.next) where.append(el('span', 'next', `next ${n.next.aisle}${n.next.more ? ` +${n.next.more}` : ''}`));
      }
      if (where.childNodes.length) box.append(where);
    }
    if (show.notes && t.notes) box.append(el('div', 'notes', t.notes));
    if (show.members || show.openSeats) {
      const ul = el('ul');
      if (show.members) for (const m of t.members) { const li = el('li'); li.append(el('span', 'nm', m.name)); ul.append(li); }
      if (show.openSeats) for (const o of t.open) ul.append(el('li', 'open', ` open seat${o.role ? ` · ${o.role}` : ''}${o.dept ? ` · ${o.dept}` : ''}`));
      if (show.members && !t.members.length && !(show.openSeats && t.open.length)) ul.append(el('li', 'open', ' nobody assigned yet'));
      if (ul.childNodes.length) box.append(ul);
    }
    return box;
  }

  /** The one shift on screen, with the teams whose shift nobody set listed after its own. */
  function shiftPanel(s, unset) {
    const box = el('section', 'shift' + (s.on ? ' on' : ''));
    box.dataset.shift = s.key;
    const head = el('div', 'sh');
    head.append(el('h2', '', s.label));
    if (s.hours) head.append(el('span', 'hours', s.hours));
    const all = [...s.teams, ...unset];
    const people = all.reduce((n, t) => n + t.members.length, 0);
    head.append(el('span', 'count', `${all.length} team${all.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'}`));
    if (s.on) head.append(el('span', 'onnow', 'On now'));
    box.append(head);
    const grid = el('div', 'teams');
    for (const t of s.teams) grid.append(teamCard(t));
    for (const t of unset) grid.append(teamCard(t, { unset: true }));
    if (!all.length) grid.append(el('div', 'empty', `No teams on the ${s.label.toLowerCase()} yet`));
    box.append(grid);
    return box;
  }

  function paint(d) {
    if (d.config) config = { ...config, ...d.config, show: { ...config.show, ...(d.config.show || {}) }, scroll: { ...config.scroll, ...(d.config.scroll || {}) } };
    const now = $('bNow');
    now.innerHTML = '';
    now.append(el('b', '', d.now.shift ? 'On now: ' : ''), document.createTextNode(d.now.label + (d.now.until ? ` · until ${d.now.until}` : '')));
    $('bSession').textContent = config.show.count ? (d.session ? d.session.name : 'No open count') : '';
    /* which shift: pinned on the address, fixed by the admin, or the one on now (the next one between shifts) */
    const key = ONLY || (config.shift === 'auto' ? (d.now.shift || d.now.next || '1') : config.shift);
    const shown = d.shifts.find((s) => s.key === key) || d.shifts[0];
    const unset = (d.shifts.find((s) => s.key === '') || { teams: [] }).teams;
    const wrap = $('bShifts');
    const grid = wrap.querySelector('.teams');
    const keep = grid ? grid.scrollTop : 0;          // a repaint never jumps the scrolling list
    wrap.innerHTML = '';
    wrap.append(shiftPanel(shown, unset));
    const next = wrap.querySelector('.teams');
    if (next && keep) { next.scrollTop = keep; scroller.pos = next.scrollTop; }
    siteTime = d.now.time || '';
    document.title = `${shown.label} · Crew board${boardBrand ? ' — ' + boardBrand : ''}`;
  }

  /* ------------------------------------------------------------ scrolling by itself
     Down the list at the admin's speed, a pause at the bottom, back up, a pause
     at the top. Only when the list is longer than the screen; a list that fits
     never moves. The position is kept as a float, because at a slow speed a
     frame moves it less than a pixel and a whole-pixel scrollTop would stall. */
  const scroller = { dir: 1, pos: 0, pauseUntil: 0, last: 0 };
  function frame(t) {
    requestAnimationFrame(frame);
    const grid = document.querySelector('.shift .teams');
    if (!grid || NO_SCROLL || !config.scroll.on) { scroller.last = 0; return; }
    const pause = (Number(config.scroll.pause) || 0) * 1000;
    if (!scroller.last) { scroller.last = t; scroller.pauseUntil = t + pause; return; }
    const dt = Math.min(0.1, (t - scroller.last) / 1000);
    scroller.last = t;
    const max = grid.scrollHeight - grid.clientHeight;
    if (max <= 4) { scroller.pos = 0; grid.scrollTop = 0; scroller.dir = 1; return; }
    if (t < scroller.pauseUntil) return;
    scroller.pos = Math.max(0, Math.min(max, scroller.pos + scroller.dir * (Number(config.pxPerSecond) || 36) * dt));
    grid.scrollTop = scroller.pos;
    if (scroller.dir > 0 && scroller.pos >= max - 0.5) { scroller.dir = -1; scroller.pauseUntil = t + pause; }
    else if (scroller.dir < 0 && scroller.pos <= 0.5) { scroller.dir = 1; scroller.pauseUntil = t + pause; }
  }
  requestAnimationFrame(frame);

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
