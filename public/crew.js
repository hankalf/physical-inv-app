/* The crew board: who is on which team, by shift, on a wall screen. No
   sign-in, no controls. It polls, never writes, and keeps the last list on
   screen if the server goes away. ?shift=1 or ?shift=2 pins it to one shift;
   ?every=30 sets the poll in seconds. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const ONLY = ['1', '2'].includes(q.get('shift') || '') ? q.get('shift') : '';
  const EVERY = Math.max(5, Number(q.get('every') || 30)) * 1000;
  let boardBrand = '';
  let lastGood = 0;
  let siteTime = '';         // the warehouse's clock, from the server: what "on now" was judged by

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function teamCard(t) {
    const box = el('div', 'team');
    box.dataset.team = t.name;
    const th = el('div', 'th');
    th.append(el('b', '', `Team ${t.name}`));
    if (t.shiftInferred) th.append(el('span', 'inf', 'shift from its people'));
    if (t.members.length) th.append(el('span', 'reach', `reaches ${t.reachLabel}`));
    box.append(th);
    if (t.notes) box.append(el('div', 'notes', t.notes));
    const ul = el('ul');
    for (const m of t.members) {
      const li = el('li');
      li.append(el('span', 'nm', m.name));
      if (m.dept) li.append(el('span', 'dept', m.dept));
      if (m.equipment.length) li.append(el('span', 'kit', m.equipment.join(' · ')));
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
      const res = await fetch('/api/board/crew', { cache: 'no-store' });
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
