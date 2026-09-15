/* Supervisor dashboard: sessions, team assignments (staggered by racking block),
   live progress, the warehouse map, second counts and the pallet report.
   Setup — logins, scanners, uploads, blocks, ERP, backups — lives in /settings. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, cell, tag, table } = window.appUi;
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);

  let sessionId = null;
  let sessions = [];

  const needSession = (el) => {
    if (sessionId) return true;
    msg(el, 'err', 'Create a session first', 'Type a name under "New session name" and click Create session.');
    return false;
  };

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('sessionChip').hidden = which !== 'main';
  }

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
    sessions = await apiJson('/api/admin/sessions');
    const sel = $('fSessionPick');
    const prior = sessionId;
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name} (${s.mode === 'cycle' ? 'cycle · ' : ''}${s.status})`;
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
    // a cycle session has no aisle plan, so its whole sub-tab goes
    const cycle = s.mode === 'cycle';
    $('teamPlanCard').hidden = cycle;
    const tab = document.querySelector('#subTabs button[data-goto="teams"]');
    if (tab) {
      tab.hidden = cycle;
      if (cycle && tab.classList.contains('current')) api.showSub('progress');
    }
    $('sessionChip').textContent = `Session #${s.id}${s.status === 'closed' ? ' (closed)' : ''}`;
    $('fPalletMode').value = s.pallet_mode;
    $('fGuided').checked = !!s.guided;
    $('fAskComments').checked = !!s.ask_comments;
    $('fAutoRecount').checked = !!s.auto_recount;
    $('fLayout').value = s.layout || '';
    $('btnCloseSession').textContent = s.status === 'closed' ? 'Reopen session' : 'Close session';
  }

  /* ------------------------------------------------------------ progress */
  async function refreshProgress() {
    const p = await apiJson(`/api/admin/sessions/${sessionId}/progress`);
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
    for (const s of p.signedOn) byTeam.set(s.team, { team: s.team, devices: s.devices, employees: JSON.parse(s.employees || '[]').join(', '), lines: 0, bins: 0 });
    for (const t of p.byTeam) byTeam.set(t.team, { ...(byTeam.get(t.team) || { team: t.team, employees: '' }), ...t, devices: t.devices });
    table($('teamTable'),
      [{ label: 'Team' }, { label: 'Scanner(s)' }, { label: 'Employees' }, { label: 'Active aisle' }, { label: 'Lines', num: true }, { label: 'Bins', num: true }, { label: 'Last scan' }],
      [...byTeam.values()].sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true })),
      (t) => {
        const tr = document.createElement('tr');
        tr.append(cell(t.team), cell(t.devices || '—'), cell(t.employees || '—', 'wrap'), cell(t.active_aisle ? aisleLabel(t.active_aisle, zoneByAisle.get(t.active_aisle)) : '—'),
          cell(t.lines || 0, 'num'), cell(t.bins || 0, 'num'), cell(t.last_scan ? new Date(t.last_scan).toLocaleTimeString() : '—'));
        return tr;
      }, 'No team has signed on yet.');

    $('refreshedAt').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  /* ------------------------------------------------------------ aisles */
  /* ------------------------------------------------------------ assignments */
  async function refreshAssignments() {
    const [rows, aisles] = await Promise.all([
      apiJson(`/api/admin/sessions/${sessionId}/assignments`),
      apiJson(`/api/admin/sessions/${sessionId}/aisles`),
    ]);
    const blockOf = new Map(aisles.map((a) => [a.aisle, a.block]));
    const activeInBlock = new Map(); // block -> [{team, levels}]
    const overlap = (a, b) => !a || !b || [...a].some((c) => b.includes(c));
    for (const r of rows) if (r.status === 'active') { const k = blockOf.get(r.aisle) || r.aisle; if (!activeInBlock.has(k)) activeInBlock.set(k, []); activeInBlock.get(k).push(r); }

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
      head.querySelector('.muted').textContent = active ? `in ${aisleLabel(active.aisle, zoneByAisle.get(active.aisle))}, ${levelsLabel(active.levels)}` : (items.every((i) => i.status === 'done') ? 'finished' : 'waiting');
      box.appendChild(head);

      const seq = document.createElement('div');
      seq.className = 'seq';
      for (const it of items.sort((a, b) => a.position - b.position || a.id - b.id)) {
        const a = document.createElement('span');
        a.className = 'a ' + it.status;
        const holder = (activeInBlock.get(blockOf.get(it.aisle) || it.aisle) || []).find((h) => h.team !== team && overlap(h.levels, it.levels));
        const blocked = it.status === 'queued' && !!holder;
        if (blocked) a.classList.add('blocked');
        a.title = blocked ? `Held: team ${holder.team} is active in this block on ${levelsLabel(holder.levels)}` : it.status;
        a.append(`${aisleLabel(it.aisle, zoneByAisle.get(it.aisle))} · ${levelsLabel(it.levels)}`);
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

  /* ------------------------------------------------------------ second counts */
  async function refreshRecounts() {
    const rows = await apiJson(`/api/admin/sessions/${sessionId}/recounts`);
    const open = rows.filter((r) => r.status !== 'done').length;
    $('recountSub').textContent = rows.length ? `${open} open · ${rows.length - open} done` : '';
    api.subCount('second', open);   // so an open second count is visible from any tab
    table($('recountTable'),
      [{ label: 'Bin' }, { label: 'Pallet' }, { label: 'Reason' }, { label: 'Detail' }, { label: 'Source' }, { label: '1st team' },
       { label: 'Team' }, { label: 'Status' }, { label: '1st count' }, { label: '2nd count' }, { label: '' }],
      rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(r.bin), cell(r.pallet_id || '—'), cell(r.reason), cell(r.detail || '', 'wrap'), cell(r.source), cell(r.first_team || '—'));
        const tdTeam = document.createElement('td');
        const inp = document.createElement('input'); inp.className = 'sm'; inp.style.width = '60px'; inp.value = r.team || ''; inp.placeholder = 'any';
        inp.title = 'Assign to a team and press Enter; blank = any team (except the first-count team)';
        inp.onkeydown = async (e) => { if (e.key !== 'Enter') return; try { await postJson(`/api/admin/sessions/${sessionId}/recounts/${r.id}`, { team: inp.value }); await refreshRecounts(); } catch (err) { msg($('recountMsg'), 'err', err.message); } };
        tdTeam.appendChild(inp); tr.appendChild(tdTeam);
        const tdSt = document.createElement('td'); tdSt.appendChild(tag(r.status)); tr.appendChild(tdSt);
        tr.append(cell(r.first_result || (r.first_lines ? '' : 'nothing'), 'wrap'), cell(r.second_result || '', 'wrap'));
        const tdBtn = document.createElement('td');
        const act = (label, body, method = 'POST') => {
          const b = document.createElement('button'); b.className = 'sm ghost'; b.textContent = label; b.style.marginRight = '4px';
          b.onclick = async () => { try { await apiJson(`/api/admin/sessions/${sessionId}/recounts/${r.id}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); await refreshAll(); } catch (err) { msg($('recountMsg'), 'err', err.message); } };
          return b;
        };
        if (r.status !== 'done') tdBtn.appendChild(act('done', { status: 'done' }));
        else tdBtn.appendChild(act('reopen', { status: 'open' }));
        tdBtn.appendChild(act('✕', null, 'DELETE'));
        tr.appendChild(tdBtn);
        return tr;
      }, 'No second counts yet.');
  }

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
      msg($('recountMsg'), 'ok', `Raised ${r.created} second count(s) from ${r.considered} pallet(s) that disagree with the report.`);
      await refreshAll();
    } catch (err) { msg($('recountMsg'), 'err', err.message); }
  };
  $('btnExportRecounts').onclick = () => download(`/api/admin/sessions/${sessionId}/export/recounts.csv`, `second-counts-session-${sessionId}.csv`);

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
  async function refreshPallets() {
    const only = $('fOnlyExceptions').checked ? '&only=exceptions' : '';
    const data = await apiJson(`/api/admin/sessions/${sessionId}/pallets?limit=500${only}`);
    table($('palletTable'),
      [{ label: 'Pallet' }, { label: 'SKU' }, { label: 'Description' }, { label: 'Expected', num: true }, { label: '1st count', num: true }, { label: 'Counted', num: true },
       { label: 'Expected bin' }, { label: 'Found in' }, { label: 'Team' }, { label: 'Comments' }, { label: 'Status' }, { label: '' }],
      data.rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(r.pallet_id), cell(r.sku), cell(r.description, 'wrap'), cell(r.expected_qty, 'num'), cell(r.recounted ? r.first_count_qty : '', 'num'), cell(r.counted_qty, 'num'),
          cell(r.expected_location), cell(r.found_location), cell(r.teams), cell(r.comments, 'wrap'));
        const td = document.createElement('td'); td.appendChild(tag(r.status));
        if (r.recounted) { td.append(' '); const t2 = tag('2nd'); t2.className = 'tag MATCH'; t2.textContent = '2nd count'; td.appendChild(t2); }
        tr.appendChild(td);
        const tdBtn = document.createElement('td');
        if (r.status !== 'MATCH' && !r.open_recounts) {
          const b = document.createElement('button'); b.className = 'sm ghost'; b.textContent = 'Recount';
          b.onclick = async () => { try { await postJson(`/api/admin/sessions/${sessionId}/recounts`, { palletId: r.pallet_id, note: `from pallet report: ${r.status}` }); await refreshAll(); } catch (err) { alert(err.message); } };
          tdBtn.appendChild(b);
        } else if (r.open_recounts) tdBtn.append('recount pending');
        tr.appendChild(tdBtn);
        return tr;
      }, 'No pallets to show.');
    $('palletNote').textContent = data.total > data.rows.length
      ? `Showing ${data.rows.length} of ${data.total} — export the CSV for the full list.` : `${data.total} row(s).`;
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
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
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
      const [x, y, w, h] = segs[0];
      const lx = horizontal ? x - 4 : x + w / 2, ly = horizontal ? y + h / 2 + 4 : y - 6;
      const label = svgEl('text', { x: lx, y: ly, 'text-anchor': horizontal ? 'end' : 'middle', class: 'aisle-label' });
      label.textContent = a.aisle;
      svg.appendChild(label);
      if (a.activeTeam || a.done) {
        const bw = 26, bh = 14;
        const bx = horizontal ? x + 2 : x + w / 2 - bw / 2, by = horizontal ? y + h / 2 - bh / 2 : y + 2;
        svg.appendChild(svgEl('rect', { x: bx, y: by, width: bw, height: bh, rx: 7, fill: a.activeTeam ? '#2f81f7' : '#2ea043' }));
        const t = svgEl('text', { x: bx + bw / 2, y: by + bh - 3, 'text-anchor': 'middle', class: 'team' });
        t.textContent = a.activeTeam ? String(a.activeTeam).split(',').map((t) => 'T' + t.trim()).join('+') : '✓';
        svg.appendChild(t);
      }
    }
    // Areas with no place on the drawing (doors, staging, ...) are summarised, not lost.
    const missing = [...byAisle.entries()].filter(([k]) => !placed.has(k)).map(([k, bays]) => {
      let c = 0, t = 0; for (const b of bays.values()) { c += b.counted; t += b.bins.length; }
      counted += c; total += t;
      return `${k} ${c}/${t}`;
    });
    return { counted, total, missing };
  }

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
    if (!needSession($('sessionMsg')) || !layouts.length) return;
    try {
      $('fLayout').value = layouts[0].id;
      await postJson(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
        autoRecount: $('fAutoRecount').checked, layout: layouts[0].id,
      });
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
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

  async function refreshMap() {
    const data = await apiJson(`/api/admin/sessions/${sessionId}/map`);
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
    $('mapNote').textContent = `${mapLevel ? 'Level ' + mapLevel + ': ' : ''}${r.counted.toLocaleString()} of ${r.total.toLocaleString()} bins have a count. Each cell is a bay; hover for the bins in it.` +
      (r.missing.length ? ` Not on the drawing — ${r.missing.join(' · ')}.` : '');
  }

  async function refreshAll() {
    if (!sessionId) return;
    await Promise.all([refreshProgress(), refreshAssignments(), refreshPallets(), refreshMap(), refreshRecounts()]);
  }

  // The map is the expensive one and it is usually off-screen, so redraw it when
  // its tab is opened rather than every thirty seconds behind the user's back.
  document.addEventListener('subshow', (e) => {
    if (e.detail === 'map' && sessionId) refreshMap().catch(() => {});
  });

  const download = (path, filename) =>
    (needSession($('palletNote')) ? api.download(path, filename) : Promise.resolve())
      .catch((err) => msg($('palletNote'), 'err', err.message));

  /* ------------------------------------------------------------ wiring */
  $('fSessionPick').onchange = (e) => { sessionId = Number(e.target.value) || null; applySessionSettings(); refreshAll(); };
  $('fOnlyExceptions').onchange = refreshPallets;

  $('btnCreate').onclick = async () => {
    try {
      const s = await postJson('/api/admin/sessions', { name: $('fNewName').value, mode: $('fNewMode').value });
      $('fNewName').value = '';
      sessionId = s.id;
      msg($('sessionMsg'), 'ok', `Created ${s.mode === 'cycle' ? 'cycle-count' : 'full count'} session #${s.id}.`, 'Upload its bin list and inventory report next.');
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnSaveSettings').onclick = async () => {
    if (!needSession($('sessionMsg'))) return;
    try {
      await postJson(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
        autoRecount: $('fAutoRecount').checked, layout: $('fLayout').value,
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

  async function queueAisles(force) {
    const r = await postJson(`/api/admin/sessions/${sessionId}/assignments`,
      { team: $('fAssignTeam').value, aisles: $('fAssignAisles').value, levels: $('fAssignLevels').value, force });
    return r;
  }

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

  $('btnExportPallets').onclick = () => download(`/api/admin/sessions/${sessionId}/export/pallets.csv`, `pallets-session-${sessionId}.csv`);
  $('btnExportCounts').onclick = () => download(`/api/admin/sessions/${sessionId}/export/counts.csv`, `counts-session-${sessionId}.csv`);
  $('btnExportExceptions').onclick = () => download(`/api/admin/sessions/${sessionId}/export/exceptions.csv`, `exceptions-session-${sessionId}.csv`);
  $('btnExportUncounted').onclick = () => download(`/api/admin/sessions/${sessionId}/export/uncounted.csv`, `uncounted-bins-session-${sessionId}.csv`);

  /* ------------------------------------------------------------ boot */
  async function loadLayouts() {
    layouts = await apiJson('/api/admin/layouts');
    const sel = $('fLayout');
    sel.innerHTML = '<option value="">Schematic (auto from bin codes)</option>';
    for (const l of layouts) {
      const o = document.createElement('option');
      o.value = l.id; o.textContent = `${l.name} (${l.aisles} aisles)`;
      sel.appendChild(o);
    }
  }
  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    (async () => { await loadLayouts(); await loadSessions(); })().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && sessionId) refreshAll().catch(() => {}); }, 30000);
})();
