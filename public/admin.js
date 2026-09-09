/* Supervisor dashboard: sessions, list uploads, racking blocks, team
   assignments (staggered by block), live progress, pallet report, exports. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('admToken') || '';
  let sessionId = null;
  let sessions = [];

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { authorization: 'Bearer ' + token, ...(options.headers || {}) },
      cache: 'no-store',
    });
    if (res.status === 401) { logout(); throw new Error('Session expired — sign in again'); }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { msg = (await res.json()).error || msg; } catch { /* keep status text */ }
      throw new Error(msg);
    }
    return res;
  }
  const apiJson = (p, o) => api(p, o).then((r) => r.json());
  const postJson = (p, body, method = 'POST') =>
    apiJson(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function msg(el, kind, text, detail) {
    el.className = 'feedback show ' + kind;
    el.textContent = text;
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      el.appendChild(d);
    }
  }
  const clearMsg = (el) => { el.className = 'feedback'; el.textContent = ''; };

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('btnLogout').hidden = which !== 'main';
    $('sessionChip').hidden = which !== 'main';
  }
  function logout() { token = ''; sessionStorage.removeItem('admToken'); show('login'); }

  async function login() {
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: $('fPassword').value }),
      });
      if (!res.ok) throw new Error('Wrong password');
      token = (await res.json()).token;
      sessionStorage.setItem('admToken', token);
      $('fPassword').value = '';
      show('main');
      await loadSessions();
    } catch (err) { msg($('loginMsg'), 'err', err.message); }
  }

  /* ------------------------------------------------------------ table helpers */
  const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; };
  const tag = (text) => { const s = document.createElement('span'); s.className = 'tag ' + text; s.textContent = text; return s; };
  function table(el, columns, rows, renderRow, empty) {
    el.innerHTML = '';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of columns) { const th = document.createElement('th'); th.textContent = c.label; if (c.num) th.className = 'num'; hr.appendChild(th); }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    if (!rows.length) { const tr = document.createElement('tr'); const td = cell(empty || 'Nothing yet.'); td.colSpan = columns.length; td.className = 'muted'; tr.appendChild(td); tbody.appendChild(tr); }
    for (const r of rows) tbody.appendChild(renderRow(r));
    el.append(thead, tbody);
  }

  /* ------------------------------------------------------------ upload guide */
  const FILE_GUIDE = {
    bins: {
      file: 'bins-template.csv',
      required: [['Bin Location', 'the code on the bin label; also accepts Location, Bin, Slot']],
      optional: [['Aisle', 'which aisle the bin is in - taken from the first part of the code if missing (A03-12-1 → A03)'],
                 ['Zone', 'area of the warehouse, for the progress view'], ['Description', '']],
      note: 'One row per bin. This is the validation list for question 3 and defines the aisles used for team assignments.',
    },
    pallets: {
      file: 'pallets-template.csv',
      required: [['Pallet ID', 'the code on the pallet / container label; also accepts Container, LPN, License Plate']],
      optional: [['SKU', 'shown to the counter after the pallet scan'], ['Description', 'shown to the counter'],
                 ['UOM', ''], ['Qty', 'what the system says is on it - drives QTY VARIANCE'],
                 ['Location', 'where the system says it is - drives WRONG BIN']],
      note: 'One row per pallet. Validation list for question 1. Re-uploading the same pallet updates it rather than duplicating it.',
    },
    plan: {
      file: 'plan-template.csv',
      required: [['Team', 'team number'], ['Aisle', 'must match an aisle from the bin list']],
      optional: [],
      note: 'One row per aisle, in the order each team should count. Upload the bin list first. Aisles can also be queued by hand in Team assignments below.',
    },
  };

  function renderGuide() {
    const g = FILE_GUIDE[$('fKind').value];
    const box = $('colGuide');
    box.innerHTML = '';
    const head = document.createElement('div');
    head.innerHTML = '<b>Columns</b> — matched by name, any order, extra columns ignored. &nbsp; <a></a>';
    const a = head.querySelector('a');
    a.href = '/templates/' + g.file;
    a.download = g.file;
    a.textContent = '⬇ Download sample ' + g.file;
    box.appendChild(head);
    const cols = document.createElement('div');
    cols.className = 'cols';
    for (const [name, why] of g.required) { const c = document.createElement('code'); c.className = 'req'; c.textContent = name + ' (required)'; c.title = why; cols.appendChild(c); }
    for (const [name, why] of g.optional) { const c = document.createElement('code'); c.textContent = name; c.title = why || 'optional'; cols.appendChild(c); }
    box.appendChild(cols);
    const list = document.createElement('div');
    list.className = 'note';
    list.innerHTML = [...g.required, ...g.optional].filter(([, why]) => why).map(([n, why]) => `<b>${n}</b>: ${why}`).join(' · ') + '<br>' + g.note;
    box.appendChild(list);
  }
  $('fKind').onchange = renderGuide;
  renderGuide();

  /* ------------------------------------------------------------ sessions */
  async function loadSessions() {
    sessions = await apiJson('/api/admin/sessions');
    const sel = $('fSessionPick');
    const prior = sessionId;
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name} (${s.status})`;
      sel.appendChild(o);
    }
    if (!sessions.length) { sel.innerHTML = '<option value="">No sessions yet — create one below</option>'; sessionId = null; return; }
    sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
    sel.value = String(sessionId);
    applySessionSettings();
    await refreshAll();
  }

  function applySessionSettings() {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    $('sessionChip').textContent = `Session #${s.id}${s.status === 'closed' ? ' (closed)' : ''}`;
    $('fPalletMode').value = s.pallet_mode;
    $('fGuided').checked = !!s.guided;
    $('fAskComments').checked = !!s.ask_comments;
    $('btnCloseSession').textContent = s.status === 'closed' ? 'Reopen session' : 'Close session';
  }

  /* ------------------------------------------------------------ progress */
  async function refreshProgress() {
    const p = await apiJson(`/api/admin/sessions/${sessionId}/progress`);
    const pct = p.bins_total ? Math.round((p.bins_counted / p.bins_total) * 100) : 0;
    $('stats').innerHTML = '';
    for (const [n, l] of [
      [p.lines.toLocaleString(), 'Count lines'],
      [`${p.bins_counted.toLocaleString()} / ${p.bins_total.toLocaleString()}`, `Bins with a count (${pct}%)`],
      [`${p.pallets_counted.toLocaleString()} / ${p.pallets_total.toLocaleString()}`, `Listed pallets found${p.pallets_unknown ? ` (+${p.pallets_unknown} not on list)` : ''}`],
      [p.teams, 'Teams counting'],
      [p.devices, 'Scanners'],
      [p.exceptions, 'Flagged lines'],
    ]) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      $('stats').appendChild(d);
    }

    // Merge sign-ons (who is on which scanner) with counting activity.
    const byTeam = new Map();
    for (const s of p.signedOn) byTeam.set(s.team, { team: s.team, devices: s.devices, employees: JSON.parse(s.employees || '[]').join(', '), lines: 0, bins: 0 });
    for (const t of p.byTeam) byTeam.set(t.team, { ...(byTeam.get(t.team) || { team: t.team, employees: '' }), ...t, devices: t.devices });
    table($('teamTable'),
      [{ label: 'Team' }, { label: 'Scanner(s)' }, { label: 'Employees' }, { label: 'Active aisle' }, { label: 'Lines', num: true }, { label: 'Bins', num: true }, { label: 'Last scan' }],
      [...byTeam.values()].sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true })),
      (t) => {
        const tr = document.createElement('tr');
        tr.append(cell(t.team), cell(t.devices || '—'), cell(t.employees || '—', 'wrap'), cell(t.active_aisle || '—'),
          cell(t.lines || 0, 'num'), cell(t.bins || 0, 'num'), cell(t.last_scan ? new Date(t.last_scan).toLocaleTimeString() : '—'));
        return tr;
      }, 'No team has signed on yet.');

    renderAisles(p.byAisle);
    $('refreshedAt').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  /* ------------------------------------------------------------ aisles */
  function renderAisles(aisles) {
    table($('aisleTable'),
      [{ label: 'Aisle' }, { label: 'Block' }, { label: 'Bins', num: true }, { label: 'Counted', num: true }, { label: 'Progress' }, { label: 'Status' }],
      aisles,
      (a) => {
        const tr = document.createElement('tr');
        tr.append(cell(a.aisle));
        const tdBlock = document.createElement('td');
        const inp = document.createElement('input');
        inp.className = 'sm';
        inp.value = a.block;
        inp.title = 'Type a block name and press Enter';
        inp.onkeydown = async (e) => {
          if (e.key !== 'Enter') return;
          try { renderAisles(await postJson(`/api/admin/sessions/${sessionId}/aisles/block`, { aisle: a.aisle, block: inp.value })); await refreshAssignments(); }
          catch (err) { alert(err.message); }
        };
        tdBlock.appendChild(inp);
        tr.append(tdBlock, cell(a.bins, 'num'), cell(a.bins_counted, 'num'));
        const td = document.createElement('td');
        const bar = document.createElement('div'); bar.className = 'bar';
        const i = document.createElement('i'); i.style.width = (a.bins ? Math.round((a.bins_counted / a.bins) * 100) : 0) + '%';
        bar.appendChild(i); td.appendChild(bar); tr.appendChild(td);
        const st = document.createElement('td');
        if (a.active_team) st.appendChild(tag('active')), st.append(` team ${a.active_team}`);
        else if (a.done_count) st.appendChild(tag('done'));
        else if (a.queued_teams) st.appendChild(tag('queued')), st.append(` team ${a.queued_teams}`);
        else st.append('—');
        tr.appendChild(st);
        return tr;
      }, 'Upload a bin list to see aisles.');
  }

  /* ------------------------------------------------------------ assignments */
  async function refreshAssignments() {
    const [rows, aisles] = await Promise.all([
      apiJson(`/api/admin/sessions/${sessionId}/assignments`),
      apiJson(`/api/admin/sessions/${sessionId}/aisles`),
    ]);
    const blockOf = new Map(aisles.map((a) => [a.aisle, a.block]));
    const activeHolders = new Map(); // block -> team
    for (const r of rows) if (r.status === 'active') activeHolders.set(blockOf.get(r.aisle) || r.aisle, r.team);

    const teams = new Map();
    for (const r of rows) { if (!teams.has(r.team)) teams.set(r.team, []); teams.get(r.team).push(r); }
    const list = $('teamList');
    list.innerHTML = '';
    if (!teams.size) { list.innerHTML = '<div class="muted">No aisles queued yet. Queue some above or upload a counting plan.</div>'; return; }

    for (const [team, items] of [...teams.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))) {
      const box = document.createElement('div');
      box.className = 'team';
      const head = document.createElement('div');
      head.className = 'head';
      const active = items.find((i) => i.status === 'active');
      head.innerHTML = `<span>Team <b></b></span><span class="muted"></span>`;
      head.querySelector('b').textContent = team;
      head.querySelector('.muted').textContent = active ? `in aisle ${active.aisle}` : (items.every((i) => i.status === 'done') ? 'finished' : 'waiting');
      box.appendChild(head);

      const seq = document.createElement('div');
      seq.className = 'seq';
      for (const it of items.sort((a, b) => a.position - b.position || a.id - b.id)) {
        const a = document.createElement('span');
        a.className = 'a ' + it.status;
        const holder = activeHolders.get(blockOf.get(it.aisle) || it.aisle);
        const blocked = it.status === 'queued' && holder && holder !== team;
        if (blocked) a.classList.add('blocked');
        a.title = blocked ? `Held: team ${holder} is active in this block` : it.status;
        a.append(it.aisle);
        if (blocked) a.append(' ⏳');
        const act = (label, status) => {
          const b = document.createElement('button');
          b.className = 'sm ghost';
          b.textContent = label;
          b.onclick = async () => {
            try {
              if (status === 'delete') await apiJson(`/api/admin/sessions/${sessionId}/assignments/${it.id}`, { method: 'DELETE' });
              else await postJson(`/api/admin/sessions/${sessionId}/assignments/${it.id}`, { status });
              clearMsg($('assignMsg'));
              await refreshAll();
            } catch (err) { msg($('assignMsg'), 'err', err.message); }
          };
          return b;
        };
        if (it.status === 'queued') { a.appendChild(act('start', 'active')); a.appendChild(act('✕', 'delete')); }
        if (it.status === 'active') { a.appendChild(act('done', 'done')); a.appendChild(act('release', 'queued')); }
        if (it.status === 'done') { a.appendChild(act('reopen', 'queued')); }
        seq.appendChild(a);
      }
      box.appendChild(seq);
      list.appendChild(box);
    }
  }

  /* ------------------------------------------------------------ pallet report */
  async function refreshPallets() {
    const only = $('fOnlyExceptions').checked ? '&only=exceptions' : '';
    const data = await apiJson(`/api/admin/sessions/${sessionId}/pallets?limit=500${only}`);
    table($('palletTable'),
      [{ label: 'Pallet' }, { label: 'SKU' }, { label: 'Description' }, { label: 'Expected', num: true }, { label: 'Counted', num: true },
       { label: 'Expected bin' }, { label: 'Found in' }, { label: 'Team' }, { label: 'Comments' }, { label: 'Status' }],
      data.rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(r.pallet_id), cell(r.sku), cell(r.description, 'wrap'), cell(r.expected_qty, 'num'), cell(r.counted_qty, 'num'),
          cell(r.expected_location), cell(r.found_location), cell(r.teams), cell(r.comments, 'wrap'));
        const td = document.createElement('td'); td.appendChild(tag(r.status)); tr.appendChild(td);
        return tr;
      }, 'No pallets to show.');
    $('palletNote').textContent = data.total > data.rows.length
      ? `Showing ${data.rows.length} of ${data.total} — export the CSV for the full list.` : `${data.total} row(s).`;
  }

  /* ------------------------------------------------------------ warehouse map */
  const SEP = /[-_./\\ ]/;
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // Bin code -> bay: the segment after the aisle ("A03-12-1" -> "12"). Bins that
  // only differ by level land in the same bay cell, coloured by how many are done.
  function bayOf(code, aisle) {
    const parts = String(code).split(SEP).filter(Boolean);
    if (parts.length >= 2) return parts[1];
    const up = String(code).toUpperCase();
    return up.startsWith(aisle) && up.length > aisle.length ? up.slice(aisle.length) : code;
  }

  async function refreshMap() {
    const data = await apiJson(`/api/admin/sessions/${sessionId}/map`);
    const svg = $('map');
    svg.innerHTML = '';
    if (!data.bins.length) { $('mapNote').textContent = 'Upload a bin list to draw the map.'; svg.setAttribute('height', 0); return; }

    // aisle -> bay -> {bins, counted, flagged}
    const byAisle = new Map();
    for (const [code, aisle, lines, flagged] of data.bins) {
      if (!byAisle.has(aisle)) byAisle.set(aisle, new Map());
      const bays = byAisle.get(aisle);
      const bay = bayOf(code, aisle);
      if (!bays.has(bay)) bays.set(bay, { bins: [], counted: 0, flagged: 0 });
      const b = bays.get(bay);
      b.bins.push(code);
      if (lines > 0) b.counted++;
      if (flagged > 0) b.flagged++;
    }

    // blocks in order; aisles inside a block touch (shared racking), blocks are
    // separated by a walkway.
    const blocks = new Map();
    for (const a of data.aisles.sort((x, y) => natural(x.block, y.block) || natural(x.aisle, y.aisle))) {
      if (!blocks.has(a.block)) blocks.set(a.block, []);
      blocks.get(a.block).push(a);
    }
    for (const aisle of byAisle.keys()) {
      if (!data.aisles.some((a) => a.aisle === aisle)) blocks.set(aisle, [{ aisle, block: aisle }]);
    }

    const CW = 34, CH = 22, GAP = 3, WALK = 28, TOP = 46, LEFT = 10;
    let x = LEFT;
    let maxBays = 0;
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
    const width = x + LEFT;
    const height = TOP + maxBays * (CH + GAP) + 12;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    let counted = 0, total = 0;
    for (const { a, x: cx, keys, bays } of cells) {
      // column background: tinted when a team is in it
      const colH = maxBays * (CH + GAP);
      svg.appendChild(svgEl('rect', { x: cx - 1, y: TOP - 1, width: CW + 2, height: colH + 2, rx: 4,
        fill: a.activeTeam ? '#1f4d8f' : a.done ? '#10281a' : '#161b22', opacity: a.activeTeam ? 0.55 : 1 }));
      const label = svgEl('text', { x: cx + CW / 2, y: 14, 'text-anchor': 'middle', class: 'aisle-label' });
      label.textContent = a.aisle;
      svg.appendChild(label);
      if (a.activeTeam || a.done || a.queuedTeams) {
        const badge = svgEl('rect', { x: cx + 2, y: 20, width: CW - 4, height: 16, rx: 8,
          fill: a.activeTeam ? '#2f81f7' : a.done ? '#2ea043' : '#30363d' });
        svg.appendChild(badge);
        const t = svgEl('text', { x: cx + CW / 2, y: 32, 'text-anchor': 'middle', class: 'team' });
        t.textContent = a.activeTeam ? 'T' + a.activeTeam : a.done ? '✓' : 'T' + String(a.queuedTeams).split(',')[0].trim();
        svg.appendChild(t);
      }
      keys.forEach((bay, i) => {
        const b = bays.get(bay);
        total += b.bins.length; counted += b.counted;
        const frac = b.bins.length ? b.counted / b.bins.length : 0;
        const fill = frac === 0 ? '#2a3038' : frac < 1 ? '#d29922' : '#2ea043';
        const y = TOP + i * (CH + GAP);
        const r = svgEl('rect', { x: cx + 2, y, width: CW - 4, height: CH, rx: 3, fill, class: 'cell',
          stroke: b.flagged ? '#f85149' : 'none', 'stroke-width': b.flagged ? 2 : 0 });
        const title = svgEl('title');
        title.textContent = `${a.aisle} bay ${bay}: ${b.counted}/${b.bins.length} counted` + (b.flagged ? `, ${b.flagged} flagged` : '') + '\n' + b.bins.join(', ');
        r.appendChild(title);
        svg.appendChild(r);
        const bl = svgEl('text', { x: cx + CW / 2, y: y + CH / 2 + 3, 'text-anchor': 'middle', class: 'bay-label',
          style: frac > 0 ? 'fill:#0d1117;font-weight:700' : '' });
        bl.textContent = bay;
        svg.appendChild(bl);
      });
    }
    $('mapNote').textContent = `${counted.toLocaleString()} of ${total.toLocaleString()} bins have a count. Each cell is a bay; hover for the bins in it.`;
  }

  async function refreshAll() {
    if (!sessionId) return;
    await Promise.all([refreshProgress(), refreshAssignments(), refreshPallets(), refreshMap()]);
  }

  async function download(path, filename) {
    const res = await api(path);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ------------------------------------------------------------ wiring */
  $('btnLogin').onclick = login;
  $('fPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('btnLogout').onclick = logout;
  $('fSessionPick').onchange = (e) => { sessionId = Number(e.target.value) || null; applySessionSettings(); refreshAll(); };
  $('fOnlyExceptions').onchange = refreshPallets;

  $('btnCreate').onclick = async () => {
    try {
      const s = await postJson('/api/admin/sessions', { name: $('fNewName').value });
      $('fNewName').value = '';
      sessionId = s.id;
      msg($('sessionMsg'), 'ok', `Created session #${s.id}. Upload its bin list and pallet list next.`);
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnSaveSettings').onclick = async () => {
    try {
      await postJson(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
      });
      msg($('sessionMsg'), 'ok', 'Settings saved. Scanners pick them up at their next sign-on.');
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnCloseSession').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const next = s.status === 'closed' ? 'open' : 'closed';
    if (next === 'closed' && !confirm('Close this session? Scanners will no longer be able to send counts to it.')) return;
    try { await postJson(`/api/admin/sessions/${sessionId}/status`, { status: next }); await loadSessions(); }
    catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };

  $('btnUpload').onclick = async () => {
    const file = $('fFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a CSV file first');
    if (!sessionId) return msg($('uploadMsg'), 'err', 'Create or select a session first');
    msg($('uploadMsg'), 'warn', `Uploading ${file.name}…`);
    try {
      const kind = $('fKind').value;
      const stats = await apiJson(`/api/admin/sessions/${sessionId}/master?kind=${kind}&replace=${$('fReplace').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await file.text() });
      const t = stats.totals;
      msg($('uploadMsg'), 'ok', `Imported ${stats.rows.toLocaleString()} rows from ${file.name}`,
        `Session now has ${t.bins.toLocaleString()} bins in ${t.aisles} aisles, ${t.pallets.toLocaleString()} pallets, ${t.assignments} planned aisle assignments` +
        (stats.skipped ? ` · ${stats.skipped} row(s) skipped (missing required column, or unknown aisle)` : ''));
      $('fFile').value = '';
      await refreshAll();
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  };

  $('btnAutoBlock').onclick = async () => {
    try {
      renderAisles(await postJson(`/api/admin/sessions/${sessionId}/aisles/auto-block`, { size: Number($('fBlockSize').value), offset: Number($('fBlockOffset').value) }));
      await refreshAssignments();
    } catch (err) { alert(err.message); }
  };

  $('btnAssign').onclick = async () => {
    try {
      const r = await postJson(`/api/admin/sessions/${sessionId}/assignments`, { team: $('fAssignTeam').value, aisles: $('fAssignAisles').value });
      const parts = [];
      if (r.added.length) parts.push(`queued ${r.added.join(', ')}`);
      if (r.activated.length) parts.push(`started ${r.activated.map((a) => `team ${a.team} in ${a.aisle}`).join('; ')}`);
      msg($('assignMsg'), r.skipped.length ? 'warn' : 'ok', parts.join(' · ') || 'Nothing to queue',
        r.skipped.map((s) => `${s.aisle}: ${s.reason}`).join(' · '));
      $('fAssignAisles').value = '';
      await refreshAll();
    } catch (err) { msg($('assignMsg'), 'err', err.message); }
  };

  $('btnExportPallets').onclick = () => download(`/api/admin/sessions/${sessionId}/export/pallets.csv`, `pallets-session-${sessionId}.csv`);
  $('btnExportCounts').onclick = () => download(`/api/admin/sessions/${sessionId}/export/counts.csv`, `counts-session-${sessionId}.csv`);
  $('btnExportExceptions').onclick = () => download(`/api/admin/sessions/${sessionId}/export/exceptions.csv`, `exceptions-session-${sessionId}.csv`);
  $('btnExportUncounted').onclick = () => download(`/api/admin/sessions/${sessionId}/export/uncounted.csv`, `uncounted-bins-session-${sessionId}.csv`);

  /* ------------------------------------------------------------ boot */
  (async () => {
    if (!token) return show('login');
    try { await apiJson('/api/admin/sessions'); show('main'); await loadSessions(); }
    catch { show('login'); }
  })();
  setInterval(() => { if (token && sessionId) refreshAll().catch(() => {}); }, 30000);
})();
