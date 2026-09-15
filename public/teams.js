/* Teams & crew: the roster, who is on which team today, and what each level of
   racking needs. Drag and drop, with a menu on every card for touch screens. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
  let token = sessionStorage.getItem('admToken') || '';
  let state = { employees: [], teams: [], config: { equipment: {}, levelRules: [] } };

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
    if (detail) { const d = document.createElement('div'); d.className = 'detail'; d.textContent = detail; el.appendChild(d); }
  }
  const clearMsg = (el) => { el.className = 'feedback'; el.textContent = ''; };

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('btnLogout').hidden = which !== 'main';
    $('countChip').hidden = which !== 'main';
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
      await refresh();
    } catch (err) { msg($('loginMsg'), 'err', err.message); }
  }

  /* ------------------------------------------------------------ helpers */
  const levelsLabel = (l) => {
    if (!l) return 'nothing above the floor';
    if (l.length === 1) return `level ${l}`;
    const contiguous = [...l].every((c, i) => i === 0 || c.charCodeAt(0) === l.charCodeAt(i - 1) + 1);
    return contiguous ? `levels ${l[0]}–${l[l.length - 1]}` : `levels ${[...l].join(', ')}`;
  };
  const allLevels = () => {
    const set = new Set();
    for (const r of state.config.levelRules) for (const c of r.levels) set.add(c);
    return [...set].sort().join('');
  };
  const kitName = (key) => state.config.equipment[key] || key;

  /* ------------------------------------------------------------ people cards */
  function personCard(e) {
    const div = document.createElement('div');
    div.className = 'person';
    div.draggable = true;
    div.dataset.badge = e.badge;
    div.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', e.badge);
      ev.dataTransfer.effectAllowed = 'move';
      div.classList.add('dragging');
    });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));

    const left = document.createElement('div');
    const who = document.createElement('div'); who.className = 'who'; who.textContent = e.name;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = [e.badge, e.dept].filter(Boolean).join(' · ') + ` · reaches ${levelsLabel(e.reach)}`;
    left.append(who, meta);
    const kit = document.createElement('div'); kit.className = 'kitrow';
    if (e.equipment.length) for (const k of e.equipment) { const s = document.createElement('span'); s.textContent = kitName(k); kit.appendChild(s); }
    else { const s = document.createElement('span'); s.textContent = 'on foot'; s.style.color = 'var(--muted)'; kit.appendChild(s); }
    left.appendChild(kit);

    const right = document.createElement('div');
    const sel = document.createElement('select');
    sel.title = 'Move to a team';
    const none = document.createElement('option'); none.value = ''; none.textContent = '— no team —'; sel.appendChild(none);
    for (const t of state.teams) { const o = document.createElement('option'); o.value = String(t.id); o.textContent = 'Team ' + t.name; sel.appendChild(o); }
    const mine = state.teams.find((t) => t.members.some((x) => x.badge === e.badge));
    sel.value = mine ? String(mine.id) : '';
    sel.onchange = () => move(e.badge, sel.value);
    const del = document.createElement('button');
    del.className = 'sm danger'; del.textContent = 'Remove'; del.style.marginTop = '6px'; del.style.width = '100%';
    del.onclick = async () => {
      if (!confirm(`Remove ${e.name} from the crew list?`)) return;
      try { await apiJson(`/api/admin/people/employees/${encodeURIComponent(e.badge)}`, { method: 'DELETE' }); await refresh(); }
      catch (err) { msg($('personMsg'), 'err', err.message); }
    };
    right.append(sel, del);

    div.append(left, right);
    return div;
  }

  async function move(badge, teamId) {
    try { await postJson('/api/admin/people/assign', { badge, teamId: teamId || null }); await refresh(); }
    catch (err) { msg($('teamMsg'), 'err', err.message); }
  }

  function dropTarget(el, teamId) {
    el.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      el.classList.remove('over');
      const badge = ev.dataTransfer.getData('text/plain');
      if (badge) await move(badge, teamId);
    });
  }

  /* ------------------------------------------------------------ render */
  function render() {
    const assigned = new Set(state.teams.flatMap((t) => t.members.map((m) => m.badge)));
    const pool = state.employees.filter((e) => !assigned.has(e.badge));

    $('countChip').textContent = `${state.employees.length} people · ${state.teams.length} teams`;
    $('poolCount').textContent = String(pool.length);
    const poolBox = $('pool');
    poolBox.innerHTML = '';
    if (!pool.length) poolBox.innerHTML = '<div class="empty">Everyone is on a team.</div>';
    for (const e of pool) poolBox.appendChild(personCard(e));
    dropTarget($('poolBucket'), '');

    const box = $('teams');
    box.innerHTML = '';
    if (!state.teams.length) box.innerHTML = '<div class="empty">No teams yet — add one above.</div>';
    const full = allLevels();
    for (const t of state.teams) {
      const card = document.createElement('div');
      card.className = 'bucket';
      const head = document.createElement('div');
      head.className = 'head';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = 'Team ' + t.name;
      const reach = document.createElement('span');
      reach.className = 'reach ' + (!t.members.length ? 'none' : t.reach === full ? 'full' : t.reach.length > 1 ? 'some' : 'none');
      reach.textContent = t.members.length ? `reaches ${levelsLabel(t.reach)}` : 'nobody assigned';
      head.append(name, reach);
      const kit = document.createElement('div');
      kit.className = 'kit';
      kit.textContent = t.members.length
        ? (t.equipment.length ? 'Between them: ' + t.equipment.map(kitName).join(', ') : 'No equipment between them — level A only')
        : (t.notes || '');
      const drop = document.createElement('div');
      drop.className = 'drop';
      if (!t.members.length) drop.innerHTML = '<div class="empty">Drag someone here</div>';
      for (const m of t.members) drop.appendChild(personCard(m));
      const del = document.createElement('button');
      del.className = 'sm ghost'; del.textContent = 'Delete team'; del.style.marginTop = '8px';
      del.onclick = async () => {
        if (!confirm(`Delete team ${t.name}? Its people go back to the crew list.`)) return;
        try { await apiJson(`/api/admin/people/teams/${t.id}`, { method: 'DELETE' }); await refresh(); }
        catch (err) { msg($('teamMsg'), 'err', err.message); }
      };
      card.append(head, kit, drop, del);
      dropTarget(card, String(t.id));
      box.appendChild(card);
    }

    renderEquipPicker();
    renderRules();
    renderReachTable();
  }

  function renderEquipPicker() {
    const box = $('equipPicker');
    const checked = new Set([...box.querySelectorAll('input:checked')].map((i) => i.value));
    box.innerHTML = '';
    for (const [key, label] of Object.entries(state.config.equipment)) {
      if (key === 'FOOT') continue;
      const l = document.createElement('label');
      l.className = 'cb';
      const i = document.createElement('input');
      i.type = 'checkbox'; i.value = key; i.checked = checked.has(key);
      l.append(i, document.createTextNode(' ' + label));
      box.appendChild(l);
    }
  }

  function renderRules() {
    const box = $('rules');
    box.innerHTML = '';
    state.config.levelRules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'rule';
      const lv = document.createElement('input');
      lv.className = 'sm lv'; lv.value = rule.levels; lv.title = 'Levels, e.g. BC or C-F';
      lv.oninput = () => { state.config.levelRules[idx].levels = lv.value; };
      row.appendChild(lv);
      const needs = document.createElement('span'); needs.className = 'muted'; needs.textContent = 'needs';
      row.appendChild(needs);
      for (const [key, label] of Object.entries(state.config.equipment)) {
        if (key === 'FOOT') continue;
        const l = document.createElement('label');
        l.className = 'cb';
        const i = document.createElement('input');
        i.type = 'checkbox'; i.checked = rule.requires.includes(key);
        i.onchange = () => {
          const set = new Set(state.config.levelRules[idx].requires);
          i.checked ? set.add(key) : set.delete(key);
          state.config.levelRules[idx].requires = [...set];
        };
        l.append(i, document.createTextNode(' ' + label));
        row.appendChild(l);
      }
      const del = document.createElement('button');
      del.className = 'sm ghost'; del.textContent = '✕';
      del.onclick = () => { state.config.levelRules.splice(idx, 1); renderRules(); };
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  // every combination of equipment, and how high it gets you
  function renderReachTable() {
    const keys = Object.keys(state.config.equipment).filter((k) => k !== 'FOOT');
    const combos = [];
    for (let mask = 0; mask < (1 << keys.length); mask++) {
      combos.push(keys.filter((_, i) => mask & (1 << i)));
    }
    const reach = (have) => {
      const set = new Set(have);
      const out = new Set();
      for (const r of state.config.levelRules) if (r.requires.every((e) => set.has(e))) for (const c of r.levels) out.add(c);
      return [...out].sort().join('');
    };
    const tbl = $('reachTable');
    tbl.innerHTML = '<thead><tr><th>Equipment between the team</th><th>Reaches</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const c of combos.sort((a, b) => a.length - b.length)) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = c.length ? c.map(kitName).join(' + ') : 'On foot only';
      const td2 = document.createElement('td'); td2.textContent = levelsLabel(reach(c));
      tr.append(td1, td2);
      body.appendChild(tr);
    }
    tbl.appendChild(body);
  }

  async function refresh() {
    state = await apiJson('/api/admin/people');
    render();
  }

  /* ------------------------------------------------------------ actions */
  async function fileToCsv(file) {
    if (!/\.xls[xm]?$/i.test(file.name)) return file.text();
    if (!window.XLSX) {
      await new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = '/vendor/xlsx.full.min.js';
        sc.onload = res; sc.onerror = () => rej(new Error('Could not load the Excel reader. Save the sheet as CSV instead.'));
        document.head.appendChild(sc);
      });
    }
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
  }

  $('btnLogin').onclick = login;
  $('fPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('btnLogout').onclick = logout;

  $('btnUpload').onclick = async () => {
    const file = $('fFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a file first');
    msg($('uploadMsg'), 'warn', `Reading ${file.name}…`);
    try {
      const stats = await apiJson(`/api/admin/people/employees/import?replace=${$('fReplace').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await fileToCsv(file) });
      msg($('uploadMsg'), stats.unknownEquipment.length ? 'warn' : 'ok',
        `Imported ${stats.imported} of ${stats.rows} rows from ${file.name}`,
        (stats.skipped ? `${stats.skipped} row(s) had no badge. ` : '') +
        (stats.unknownEquipment.length ? `Equipment not recognised, so ignored: ${stats.unknownEquipment.join(', ')}. Add it under the level rules if it should count.` : ''));
      $('fFile').value = '';
      await refresh();
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  };
  $('btnExport').onclick = async () => {
    const res = await api('/api/admin/people/export/employees.csv');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'employees.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  $('btnAddPerson').onclick = async () => {
    try {
      const equipment = [...$('equipPicker').querySelectorAll('input:checked')].map((i) => i.value);
      const e = await postJson('/api/admin/people/employees', {
        badge: $('fBadge').value, name: $('fName').value, dept: $('fDept').value, equipment,
      });
      msg($('personMsg'), 'ok', `${e.name} saved`, `Reaches ${levelsLabel(e.reach)}.`);
      $('fBadge').value = ''; $('fName').value = '';
      await refresh();
    } catch (err) { msg($('personMsg'), 'err', err.message); }
  };
  $('fBadge').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fName').focus(); });

  $('btnAddTeam').onclick = async () => {
    try {
      await postJson('/api/admin/people/teams', { name: $('fTeamName').value, notes: $('fTeamNotes').value });
      clearMsg($('teamMsg'));
      $('fTeamName').value = ''; $('fTeamNotes').value = '';
      await refresh();
    } catch (err) { msg($('teamMsg'), 'err', err.message); }
  };
  $('fTeamName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddTeam').click(); });

  $('btnAddRule').onclick = () => { state.config.levelRules.push({ levels: '', requires: [] }); renderRules(); };
  $('btnSaveRules').onclick = async () => {
    try {
      state.config = await postJson('/api/admin/people/equipment', state.config);
      msg($('rulesMsg'), 'ok', 'Rules saved.', 'Assignments are checked against them from now on.');
      await refresh();
    } catch (err) { msg($('rulesMsg'), 'err', err.message); }
  };
  $('btnResetRules').onclick = async () => {
    state.config = {
      equipment: { FOOT: 'On foot', 'DOCK TRUCK': 'Dock truck', 'SCISSOR LIFT': 'Scissor lift', 'HIGH REACH': 'High reach truck' },
      levelRules: [
        { levels: 'A', requires: [] },
        { levels: 'BC', requires: ['DOCK TRUCK', 'SCISSOR LIFT'] },
        { levels: 'CDEF', requires: ['HIGH REACH', 'SCISSOR LIFT'] },
      ],
    };
    renderRules(); renderReachTable(); renderEquipPicker();
    msg($('rulesMsg'), 'warn', 'Defaults loaded — press Save rules to keep them.');
  };

  /* ------------------------------------------------------------ boot */
  (async () => {
    if (!token) return show('login');
    try { await apiJson('/api/admin/people'); show('main'); await refresh(); }
    catch { show('login'); }
  })();
})();
