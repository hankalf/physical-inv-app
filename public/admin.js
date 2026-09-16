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
    sessions = await apiJson('/api/admin/sessions');
    const prior = sessionId;
    if (!sessions.length) {
      sessionId = null;
      picker.render([], null);
      applySessionSettings();
      return;
    }
    // the list puts open sessions first, so the default is a live count
    sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
    picker.render(sessions, sessionId);
    applySessionSettings();
    await refreshAll();
  }

  function applySessionSettings() {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) {
      $('sessionCardSub').textContent = 'no count session yet — create one below';
      return;
    }
    // a cycle session has no aisle plan, so its whole sub-tab goes
    const cycle = s.mode === 'cycle';
    $('teamPlanCard').hidden = cycle;
    const tab = document.querySelector('#subTabs button[data-goto="teams"]');
    if (tab) {
      tab.hidden = cycle;
      if (cycle && tab.classList.contains('current')) api.showSub('progress');
    }
    $('sessionCardSub').textContent = `#${s.id} · ${s.mode === 'cycle' ? 'cycle count' : 'full count'} · ${s.status}`;
    $('fPalletMode').value = s.pallet_mode;
    $('fGuided').checked = !!s.guided;
    $('fAskComments').checked = !!s.ask_comments;
    $('fAutoRecount').checked = !!s.auto_recount;
    $('fRecMinQty').value = s.recount_min_qty || 0;
    $('fRecMinPct').value = s.recount_min_pct || 0;
    $('fRecCap').value = s.recount_cap || 0;
    $('fAskLot').checked = !!s.ask_lot;
    $('fAskExpiry').checked = !!s.ask_expiry;
    $('fDefaultSession').checked = defaultSessionId === s.id;
    $('fDefaultSession').disabled = s.status === 'closed';
    $('fLayout').value = s.layout || '';
    $('btnCloseSession').textContent = s.status === 'closed' ? 'Reopen session' : 'Close session';
    // deleting is only offered once a count is closed: an open one may still have scanners on it
    $('btnDeleteSession').disabled = s.status !== 'closed';
    $('btnDeleteSession').title = s.status === 'closed'
      ? 'Delete this count and everything counted against it. This cannot be undone.'
      : 'Close the count first — an open one may still have scanners posting to it.';
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
       { label: 'Expected bin' }, { label: 'Found in' }, { label: 'Lot' }, { label: 'Expiry' }, { label: 'Team' }, { label: 'Comments' }, { label: 'Status' }, { label: '' }],
      data.rows,
      (r) => {
        const tr = document.createElement('tr');
        /* a pallet wearing two labels: say which tag belongs to which pallet,
           so nobody reads the second one as stock that is missing */
        const tdPallet = document.createElement('td');
        tdPallet.append(r.pallet_id);
        if (r.alias_of) {
          const t = tag('SECOND LABEL');
          t.textContent = `2nd label of ${r.alias_of}`;
          t.style.marginLeft = '5px';
          tdPallet.appendChild(t);
        } else if (r.also_tagged) {
          const t = tag('SECOND LABEL');
          t.textContent = `also tagged ${r.also_tagged}`;
          t.style.marginLeft = '5px';
          tdPallet.appendChild(t);
        }
        tr.append(tdPallet, cell(r.sku), cell(r.description, 'wrap'), cell(r.expected_qty, 'num'), cell(r.recounted ? r.first_count_qty : '', 'num'), cell(r.counted_qty, 'num'),
          cell(r.expected_location), cell(r.found_location));
        // lot and expiry are blank unless the site tracks them, so they cost nothing when it does not
        const tdLot = document.createElement('td');
        if (r.found_lot || r.expected_lot) {
          tdLot.append(r.found_lot || r.expected_lot);
          if (r.lot_status && r.lot_status !== 'LOT MATCH') {
            const t = tag(r.lot_status === 'WRONG LOT' ? 'MISSING' : 'queued');
            t.textContent = r.lot_status === 'WRONG LOT' ? 'wrong lot' : r.lot_status === 'NO LOT SCANNED' ? 'not scanned' : 'not on report';
            t.style.marginLeft = '5px';
            t.title = r.expected_lot ? `The report says lot ${r.expected_lot}` : 'No lot for this pallet on the report';
            tdLot.appendChild(t);
          }
        }
        tr.appendChild(tdLot);
        const tdExp = document.createElement('td');
        if (r.expiry) {
          tdExp.append(r.expiry);
          if (r.expiry_status && r.expiry_status !== 'IN DATE') {
            const t = tag(r.expiry_status === 'EXPIRED' ? 'MISSING' : 'queued');
            t.textContent = r.expiry_status === 'EXPIRED' ? 'expired' : 'soon';
            t.style.marginLeft = '5px';
            tdExp.appendChild(t);
          }
        }
        tr.appendChild(tdExp);
        tr.append(cell(r.teams), cell(r.comments, 'wrap'));
        const td = document.createElement('td'); td.appendChild(tag(r.status));
        if (r.recounted) { td.append(' '); const t2 = tag('2nd'); t2.className = 'tag MATCH'; t2.textContent = '2nd count'; td.appendChild(t2); }
        tr.appendChild(td);
        const tdBtn = document.createElement('td');
        if (r.status !== 'MATCH' && r.status !== 'SECOND LABEL' && !r.open_recounts) {
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
    // Areas with no place on the drawing (doors, staging, ...) are summarised, not lost.
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
     grey untouched. The label carries the zone, the code and the percentage,
     and the whole thing is clickable. */
  const RING = {
    done:    { stroke: '#2ea043', label: 'complete' },
    active:  { stroke: '#2f81f7', label: 'team counting' },
    partial: { stroke: '#d29922', label: 'part counted' },
    queued:  { stroke: '#8957e5', label: 'queued to a team' },
    idle:    { stroke: '#8b949e', label: 'not started' },
  };
  /* The ring colour is right for a 2px line on a pale drawing and too dark for
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
    if (!needSession($('sessionMsg')) || !layouts.length) return;
    try {
      $('fLayout').value = layouts[0].id;
      await postJson(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
        autoRecount: $('fAutoRecount').checked, layout: layouts[0].id,
        recountMinQty: $('fRecMinQty').value, recountMinPct: $('fRecMinPct').value, recountCap: $('fRecCap').value,
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

  let lastMap = { aisles: [], bins: [] };
  let defaultSessionId = 0;

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

  /** Re-read the session list so the header picker's progress stays live. */
  async function refreshPicker() {
    sessions = await apiJson('/api/admin/sessions');
    picker.render(sessions, sessionId);
  }

  async function refreshDefaultSession() {
    defaultSessionId = (await apiJson('/api/admin/default-session')).sessionId || 0;
  }

  async function refreshAll() {
    if (!sessionId) return;
    await Promise.all([refreshProgress(), refreshAssignments(), refreshPallets(), refreshMap(), refreshRecounts(), refreshPicker()]);
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
  $('fOnlyExceptions').onchange = refreshPallets;

  /* Creating a count is also where its lists come from: a count with no
     inventory report to compare against is a count nobody can act on. Both
     files are optional here, and Getting started tracks whatever is left. */
  /* Deleting a count is the only thing in the app that cannot be undone, so it
     says what will go before it asks, and asks for the name back when there are
     counted lines to lose. */
  $('btnDeleteSession').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    let had;
    try { had = (await apiJson(`/api/admin/sessions/${sessionId}`)).contents; }
    catch (err) { return msg($('sessionMsg'), 'err', err.message); }

    const lines = [
      `${had.counts.toLocaleString()} counted lines`,
      `${had.bins.toLocaleString()} bins`,
      `${had.pallets.toLocaleString()} pallets`,
      `${had.recounts.toLocaleString()} second counts`,
      `${had.assignments.toLocaleString()} aisle assignments`,
    ].join('\n  · ');
    if (!confirm(`Delete "${s.name}" (#${s.id}) and everything under it?\n\n  · ${lines}\n\nThis cannot be undone. The audit log keeps a record that it happened.`)) return;

    let confirmName = '';
    if (had.counts > 0) {
      confirmName = prompt(`This count holds ${had.counts.toLocaleString()} counted lines.\n\nType its name exactly to confirm:\n\n${s.name}`, '');
      if (confirmName === null) return;
    }
    try {
      msg($('sessionMsg'), 'warn', 'Deleting…');
      const gone = await apiJson(`/api/admin/sessions/${sessionId}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName }),
      });
      sessionId = null;
      await refreshDefaultSession();
      await loadSessions();
      msg($('sessionMsg'), 'ok', `Deleted "${gone.name}".`,
        gone.backup ? `A copy of the database was taken first as ${gone.backup} — Settings → Backups & log.` : 'It held no counted lines.');
    } catch (err) { msg($('sessionMsg'), 'err', 'Not deleted', err.message); }
  };

  $('btnCreate').onclick = async () => {
    const files = [['bins', $('fNewBins').files[0]], ['pallets', $('fNewPallets').files[0]]].filter(([, f]) => f);
    try {
      msg($('sessionMsg'), 'warn', 'Creating…');
      const s = await postJson('/api/admin/sessions', { name: $('fNewName').value, mode: $('fNewMode').value });
      sessionId = s.id;
      $('fNewName').value = '';

      const loaded = [];
      const failed = [];
      for (const [kind, file] of files) {
        msg($('sessionMsg'), 'warn', `Reading ${file.name}…`);
        try {
          const stats = await apiJson(`/api/admin/sessions/${s.id}/master?kind=${kind}`,
            { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await window.appUi.fileToCsv(file) });
          loaded.push(`${stats.rows.toLocaleString()} rows from ${file.name}`);
        } catch (err) { failed.push(`${file.name}: ${err.message}`); }
      }
      $('fNewBins').value = ''; $('fNewPallets').value = '';

      const what = `Created ${s.mode === 'cycle' ? 'cycle count' : 'full count'} #${s.id}.`;
      if (failed.length) {
        msg($('sessionMsg'), 'warn', what, `${loaded.length ? 'Imported ' + loaded.join(' and ') + '. ' : ''}Could not read ${failed.join('; ')}. Upload it under Settings.`);
      } else if (loaded.length) {
        msg($('sessionMsg'), 'ok', what, `Imported ${loaded.join(' and ')}. Check Settings → Getting started for anything still needed.`);
      } else {
        msg($('sessionMsg'), 'ok', what, 'Next: upload its bin list and inventory report — Settings → Getting started walks you through it.');
      }
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnSaveSettings').onclick = async () => {
    if (!needSession($('sessionMsg'))) return;
    try {
      await postJson(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
        autoRecount: $('fAutoRecount').checked, layout: $('fLayout').value,
        recountMinQty: $('fRecMinQty').value, recountMinPct: $('fRecMinPct').value, recountCap: $('fRecCap').value,
        askLot: $('fAskLot').checked, askExpiry: $('fAskExpiry').checked,
      });
      const wantDefault = $('fDefaultSession').checked;
      if (wantDefault !== (defaultSessionId === sessionId)) {
        await postJson('/api/admin/default-session', { sessionId: wantDefault ? sessionId : 0 });
        await refreshDefaultSession();
      }
      msg($('sessionMsg'), 'ok', 'Settings saved. Scanners pick them up within about half a minute.',
        defaultSessionId === sessionId ? 'Every scanner will land on this count at sign-on.' : '');
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
    (async () => { await loadLayouts(); await refreshDefaultSession(); await loadSessions(); })().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && sessionId) refreshAll().catch(() => {}); }, 30000);
})();
