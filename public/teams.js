/* Teams & crew: the roster, who is on which team today, and what each level of
   racking needs. Drag and drop, with a menu on every card for touch screens. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, fileToCsv } = window.appUi;
  const norm = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);

  let state = { employees: [], teams: [], config: { equipment: {}, levelRules: [] } };
  let shiftView = '';
  let deptView = '';

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('countChip').hidden = which !== 'main';
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
  function personCard(e, seatRole = '') {
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
    const who = document.createElement('div'); who.className = 'who';
    who.append(Object.assign(document.createElement('span'), { textContent: e.name }), deptChip(e.dept));
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${e.badge} · reaches ${levelsLabel(e.reach)}`;
    left.append(who, meta);
    const kit = document.createElement('div'); kit.className = 'kitrow';
    if (e.equipment.length) for (const k of e.equipment) { const s = document.createElement('span'); s.textContent = kitName(k); kit.appendChild(s); }
    else { const s = document.createElement('span'); s.textContent = 'on foot'; s.style.color = 'var(--muted)'; kit.appendChild(s); }
    left.appendChild(kit);
    /* on a team from the team sheet: the job the sheet gives them on this team */
    if (seatRole) left.appendChild(Object.assign(document.createElement('div'), { className: 'meta seatrole', textContent: `On this team: ${seatRole}` }));
    const sized = GEAR_KEYS.some(([k]) => e[k]);
    left.appendChild(Object.assign(document.createElement('div'), {
      className: 'gearline' + (sized ? '' : ' none'),
      textContent: sized ? GEAR_KEYS.map(([k, l]) => `${l} ${e[k] || '—'}`).join(' · ') : 'No gear sizes yet',
    }));

    const right = document.createElement('div');
    const sel = document.createElement('select');
    sel.title = 'Move to a team';
    const none = document.createElement('option'); none.value = ''; none.textContent = '— no team —'; sel.appendChild(none);
    for (const t of state.teams) { const o = document.createElement('option'); o.value = String(t.id); o.textContent = 'Team ' + t.name; sel.appendChild(o); }
    const mine = state.teams.find((t) => t.members.some((x) => x.badge === e.badge));
    sel.value = mine ? String(mine.id) : '';
    sel.onchange = () => move(e.badge, sel.value);
    /* Quiet until it is wanted: a red block against every name on the crew list
       reads as a page full of warnings rather than a list of people. */
    const del = document.createElement('button');
    del.className = 'sm ghost del'; del.textContent = 'Remove'; del.title = `Remove ${e.name} from the crew list`;
    del.style.marginTop = '6px'; del.style.width = '100%';
    del.onclick = () => removeEmployee(e, $('teamMsg'));
    right.append(sel);
    /* everything about the person, on the card itself: opened under the name, saved in one go */
    const edit = document.createElement('button');
    edit.className = 'sm'; edit.textContent = 'Edit'; edit.title = `Edit ${e.name}: clock in number, name, department, equipment, sizes`;
    edit.style.marginTop = '6px'; edit.style.width = '100%';
    edit.dataset.gearEdit = e.badge;
    edit.onclick = () => {
      const open = div.querySelector('.empform');
      if (open) { open.remove(); div.draggable = true; return; }
      div.draggable = false;                        // typing in a box should not start a drag
      div.appendChild(employeeForm(e, $('teamMsg'), () => { div.draggable = true; }));   // under the whole card, not squeezed beside the menu
    };
    right.append(edit, del);

    div.append(left, right);
    return div;
  }

  /* ------------------------------------------------------------ gear sizes */
  const GEAR_KEYS = [['jacket', 'Jacket'], ['bibs', 'Bibs'], ['boots', 'Boots']];
  let gearSizes = null;                              // the size lists, from the server
  const CLOTHES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
  const sizesFor = (key) => {
    const g = gearSizes && gearSizes.find((x) => x.key === key);
    if (g) return g.sizes;
    if (key !== 'boots') return CLOTHES;
    const out = []; for (let n = 5; n <= 16; n += 0.5) out.push(String(n)); return out;
  };
  function deptChip(dept) {
    return Object.assign(document.createElement('span'), {
      className: 'deptchip' + (dept ? '' : ' none'), textContent: dept || 'No department', title: 'Department',
    });
  }
  function sizeSelect(key, value) {
    const sel = document.createElement('select');
    sel.dataset.gear = key;
    const list = sizesFor(key);
    sel.append(Object.assign(document.createElement('option'), { value: '', textContent: '—' }));
    for (const v of list) sel.append(Object.assign(document.createElement('option'), { value: v, textContent: v }));
    // a size written some other way on an upload (11W, L TALL) stays choosable
    if (value && !list.includes(value)) sel.append(Object.assign(document.createElement('option'), { value, textContent: value }));
    sel.value = value || '';
    return sel;
  }
  function deptInput(value) {
    const inp = Object.assign(document.createElement('input'), { value: value || '', placeholder: 'e.g. Freezer', className: 'dept' });
    inp.setAttribute('list', 'deptList');
    inp.dataset.gear = 'dept';
    return inp;
  }
  /* One form for a person, wherever they are edited - their card on Teams,
     or their row under Employees: every field, saved in one go. */
  function employeeForm(e, msgBox, done) {
    const box = document.createElement('div');
    box.className = 'empform gearedit';
    box.dataset.badge = e.badge;
    const field = (label, el) => {
      const w = document.createElement('div');
      w.append(Object.assign(document.createElement('label'), { textContent: label }), el);
      return w;
    };
    const badge = Object.assign(document.createElement('input'), { value: e.badge, autocomplete: 'off' });
    badge.dataset.f = 'badge';
    const name = Object.assign(document.createElement('input'), { value: e.name, autocomplete: 'off' });
    name.dataset.f = 'name';
    const dept = deptInput(e.dept);
    const sels = GEAR_KEYS.map(([k]) => sizeSelect(k, e[k]));
    const kit = document.createElement('div');
    kit.className = 'kitpick';
    for (const [key, label] of Object.entries(state.config.equipment)) {
      if (key === 'FOOT') continue;
      const l = document.createElement('label'); l.className = 'cb';
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', value: key, checked: e.equipment.includes(key) });
      l.append(c, document.createTextNode(' ' + label));
      kit.appendChild(l);
    }
    if (!kit.children.length) kit.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'No equipment set up — Equipment rules' }));
    box.append(field('Clock in number', badge), field('Name', name), field('Department', dept),
      field('Jacket', sels[0]), field('Bibs (overalls)', sels[1]), field('Boots', sels[2]));
    box.append(Object.assign(document.createElement('label'), { textContent: 'Equipment', style: 'grid-column:1/-1;margin-bottom:-4px' }), kit);
    const row = document.createElement('div'); row.className = 'full';
    const save = Object.assign(document.createElement('button'), { className: 'sm primary', textContent: 'Save' });
    const cancel = Object.assign(document.createElement('button'), { className: 'sm ghost', textContent: 'Cancel' });
    const del = Object.assign(document.createElement('button'), { className: 'sm ghost del', textContent: 'Remove', title: `Remove ${e.name} from the crew list` });
    save.onclick = async () => {
      const newBadge = norm(badge.value);
      if (newBadge && newBadge !== e.badge && !confirm(`Change ${e.name}'s clock in number from ${e.badge} to ${newBadge}? Counts already scanned keep ${e.badge}.`)) return;
      try {
        const body = { badge: badge.value, name: name.value, dept: dept.value, equipment: [...kit.querySelectorAll('input:checked')].map((c) => c.value) };
        GEAR_KEYS.forEach(([k], i) => { body[k] = sels[i].value; });
        const saved = await postJson(`/api/admin/people/employees/${encodeURIComponent(e.badge)}`, body);
        msg(msgBox, 'ok', `${saved.name} saved`, [saved.badge, saved.dept || 'No department', `reaches ${levelsLabel(saved.reach)}`, ...GEAR_KEYS.map(([k, l]) => `${l} ${saved[k] || '—'}`)].join(' · '));
        editing = '';
        await refresh();
      } catch (err) { msg(msgBox, 'err', `${e.name}: ${err.message}`); }
    };
    cancel.onclick = () => { box.remove(); editing = ''; done(); };
    del.onclick = () => removeEmployee(e, msgBox);
    for (const inp of [badge, name, dept]) inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save.click(); if (ev.key === 'Escape') cancel.click(); });
    row.append(save, cancel, del);
    box.appendChild(row);
    setTimeout(() => name.focus(), 0);
    return box;
  }
  async function removeEmployee(e, msgBox) {
    const on = e.team ? ` They come off team ${e.team}.` : '';
    if (!confirm(`Remove ${e.name} (${e.badge}) from the crew list?${on} Counts they already scanned stay as they are.`)) return;
    try {
      await apiJson(`/api/admin/people/employees/${encodeURIComponent(e.badge)}`, { method: 'DELETE' });
      msg(msgBox, 'ok', `${e.name} removed from the crew list`);
      editing = '';
      await refresh();
    } catch (err) { msg(msgBox, 'err', err.message); }
  }

  /* The Employees tab: everyone on the crew list, whatever team they are on,
     with Edit and Remove on every row. */
  let editing = '';                                  // the badge whose row is open for editing
  function renderPeople() {
    const depts = [...new Set(state.employees.map((e) => (e.dept || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const dsel = $('fPeopleDept');
    if (dsel.dataset.have !== depts.join('|')) {
      const was = dsel.value;
      dsel.dataset.have = depts.join('|');
      dsel.innerHTML = '<option value="">Every department</option><option value="-">No department</option>';
      for (const d of depts) dsel.append(Object.assign(document.createElement('option'), { value: d, textContent: d }));
      dsel.value = depts.includes(was) || was === '-' ? was : '';
    }
    const tsel = $('fPeopleTeam');
    const teamsHave = state.teams.map((t) => t.name).join('|');
    if (tsel.dataset.have !== teamsHave) {
      const was = tsel.value;
      tsel.dataset.have = teamsHave;
      tsel.innerHTML = '<option value="">Anyone</option><option value="none">Not on a team</option>';
      for (const t of state.teams) tsel.append(Object.assign(document.createElement('option'), { value: t.name, textContent: 'Team ' + t.name }));
      tsel.value = [...tsel.options].some((o) => o.value === was) ? was : '';
    }
    const q = norm($('fPeopleFind').value);
    const d = dsel.value; const t = tsel.value;
    const rows = state.employees.filter((e) => (!q || norm(e.name).includes(q) || norm(e.badge).includes(q) || norm(e.dept).includes(q))
      && (!d || (d === '-' ? !e.dept : e.dept.trim() === d))
      && (!t || (t === 'none' ? !e.team : e.team === t)));
    const n = state.employees.length;
    $('peopleChip').textContent = rows.length === n ? `${n} ${n === 1 ? 'person' : 'people'}` : `${rows.length} of ${n}`;
    const COLS = [{ label: 'Clock in number' }, { label: 'Name' }, { label: 'Department' }, { label: 'Team' }, { label: 'Equipment' }, { label: 'Jacket · Bibs · Boots' }, { label: '' }];
    window.appUi.table('peopleTable', COLS, rows, (e) => {
      const tr = document.createElement('tr');
      tr.dataset.badge = e.badge;
      const td = (text, cls) => { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; tr.appendChild(c); return c; };
      td(e.badge); td(e.name);
      const dc = document.createElement('td'); dc.appendChild(deptChip(e.dept)); tr.appendChild(dc);
      td(e.team ? 'Team ' + e.team : '—');
      td(e.equipment.length ? e.equipment.map(kitName).join(', ') : 'on foot', 'kitlist');
      td(GEAR_KEYS.some(([k]) => e[k]) ? GEAR_KEYS.map(([k]) => e[k] || '—').join(' · ') : '—', 'sizes');
      const acts = document.createElement('td'); acts.className = 'acts';
      const edit = Object.assign(document.createElement('button'), { className: 'sm', textContent: editing === e.badge ? 'Close' : 'Edit', title: `Edit ${e.name}` });
      edit.dataset.edit = e.badge;
      edit.onclick = () => { editing = editing === e.badge ? '' : e.badge; renderPeople(); };
      const del = Object.assign(document.createElement('button'), { className: 'sm ghost del', textContent: 'Remove', title: `Remove ${e.name} from the crew list` });
      del.dataset.remove = e.badge;
      del.onclick = () => removeEmployee(e, $('peopleMsg'));
      acts.append(edit, del);
      tr.appendChild(acts);
      if (editing !== e.badge) return tr;
      /* the open row: its form in a row of its own under it */
      tr.className = 'editing';
      const frag = document.createDocumentFragment();
      const formRow = document.createElement('tr'); formRow.className = 'formrow';
      const cell = document.createElement('td'); cell.colSpan = COLS.length;
      cell.appendChild(employeeForm(e, $('peopleMsg'), () => renderPeople()));
      formRow.appendChild(cell);
      frag.append(tr, formRow);
      return frag;
    }, state.employees.length ? 'Nobody matches.' : 'Nobody on the crew list yet — add someone above, or upload the list.');
  }
  $('fPeopleFind').oninput = () => renderPeople();
  $('fPeopleFind').onfocus = () => renderPeople();     // a search hit fills it in and focuses it
  $('fPeopleDept').onchange = () => renderPeople();
  $('fPeopleTeam').onchange = () => renderPeople();

  /* The Gear sizes tab: everyone in a table, a size saved the moment it is
     picked, and the totals that an order is placed from. */
  let gearDept = '';
  let gear = null;
  async function loadGear() {
    gear = await apiJson(`/api/admin/people/gear?dept=${encodeURIComponent(gearDept)}`);
    gearSizes = gear.gear;
    const dsel = $('fGearDept');
    const have = gear.depts.join('|');
    if (dsel.dataset.have !== have) {
      dsel.dataset.have = have;
      dsel.innerHTML = '<option value="">Every department</option>';
      for (const d of gear.depts) dsel.append(Object.assign(document.createElement('option'), { value: d, textContent: d }));
    }
    dsel.value = gearDept;
    renderGearTotals();
    renderGearTable();
  }
  function renderGearTotals() {
    const box = $('gearTotals');
    box.innerHTML = '';
    for (const t of gear.totals) {
      const b = document.createElement('div');
      b.className = 'gearbox';
      b.dataset.item = t.key;
      const head = document.createElement('div'); head.className = 't';
      head.append(Object.assign(document.createElement('div'), { textContent: t.plural }),
        Object.assign(document.createElement('span'), { className: 'grand', textContent: `Total ${t.entered}` }));
      const sizes = document.createElement('div'); sizes.className = 'sizes';
      for (const s of t.sizes) {
        const chip = document.createElement('span'); chip.textContent = s.size;
        chip.append(Object.assign(document.createElement('b'), { textContent: s.count }));
        sizes.appendChild(chip);
      }
      if (t.missing) {
        const chip = document.createElement('span'); chip.className = 'miss'; chip.textContent = 'Not entered';
        chip.append(Object.assign(document.createElement('b'), { textContent: t.missing }));
        sizes.appendChild(chip);
      }
      if (!t.sizes.length && !t.missing) sizes.append(Object.assign(document.createElement('span'), { textContent: 'Nobody on the list', className: 'muted' }));
      b.append(head, sizes);
      box.appendChild(b);
    }
  }
  function renderGearTable() {
    const q = norm($('fGearFind').value);
    const missingOnly = $('fGearMissing').checked;
    const rows = gear.people.filter((e) => (!q || norm(e.name).includes(q) || norm(e.badge).includes(q))
      && (!missingOnly || GEAR_KEYS.some(([k]) => !e[k])));
    window.appUi.table('gearTable', [
      { label: 'Clock in number' }, { label: 'Name' }, { label: 'Department' }, { label: 'Team' },
      { label: 'Jacket' }, { label: 'Bibs (overalls)' }, { label: 'Boots' },
    ], rows, (e) => {
      const tr = document.createElement('tr');
      tr.dataset.badge = e.badge;
      const td = (content) => { const c = document.createElement('td'); if (typeof content === 'string') c.textContent = content; else c.appendChild(content); tr.appendChild(c); return c; };
      td(e.badge); td(e.name);
      const dept = deptInput(e.dept);
      td(dept);
      td(e.team ? 'Team ' + e.team : '—');
      const sels = GEAR_KEYS.map(([k]) => { const s = sizeSelect(k, e[k]); td(s); return s; });
      const save = async (el, key) => {
        const cell = el.parentElement;
        try {
          const saved = await postJson(`/api/admin/people/employees/${encodeURIComponent(e.badge)}/gear`, { [key]: el.value });
          Object.assign(e, saved);
          cell.classList.remove('saved'); void cell.offsetWidth; cell.classList.add('saved');
          setTimeout(() => cell.classList.remove('saved'), 900);
          clearMsg($('gearMsg'));
          // the totals follow; the table stays put, so the next box is still where you left it
          const fresh = await apiJson(`/api/admin/people/gear?dept=${encodeURIComponent(gearDept)}`);
          gear.totals = fresh.totals;
          if (key === 'dept' && fresh.depts.join('|') !== gear.depts.join('|')) { gear.depts = fresh.depts; $('fGearDept').dataset.have = ''; }
          renderGearTotals();
          stale = true;                              // the crew cards show sizes too
        } catch (err) { msg($('gearMsg'), 'err', `${e.name}: ${err.message}`); }
      };
      dept.onchange = () => save(dept, 'dept');
      sels.forEach((s, i) => { s.onchange = () => save(s, GEAR_KEYS[i][0]); });
      return tr;
    }, missingOnly ? 'Everyone has all three sizes.' : 'Nobody on the crew list yet — add people under Employees.');
  }
  let stale = false;
  $('fGearDept').onchange = () => { gearDept = $('fGearDept').value; loadGear().catch((err) => msg($('gearMsg'), 'err', err.message)); };
  $('fGearFind').oninput = () => gear && renderGearTable();
  $('fGearMissing').onchange = () => gear && renderGearTable();
  $('btnGearExport').onclick = async () => {
    const b = $('btnGearExport'); const was = b.textContent;
    b.disabled = true; b.textContent = 'Building…';
    try {
      const [data, XLSX] = await Promise.all([apiJson(`/api/admin/people/gear?dept=${encodeURIComponent(gearDept)}`), window.appUi.loadXlsx()]);
      const wb = XLSX.utils.book_new();
      for (const sh of data.sheets) {
        const ws = XLSX.utils.json_to_sheet(sh.rows, { header: sh.columns });
        ws['!cols'] = sh.columns.map((c) => ({ wch: Math.min(40, Math.max(String(c).length, ...sh.rows.map((r) => String(r[c] ?? '').length)) + 2) }));
        if (sh.rows.length && sh.name === 'Names and sizes') ws['!autofilter'] = { ref: ws['!ref'] };
        XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
      }
      XLSX.writeFile(wb, data.filename);
      msg($('gearMsg'), 'ok', `Exported ${data.people.length} people`, data.filename);
    } catch (err) { msg($('gearMsg'), 'err', 'Could not build the export', err.message); }
    finally { b.disabled = false; b.textContent = was; }
  };
  document.addEventListener('subshow', (ev) => {
    if (!api.me) return;
    if (ev.detail === 'gear') loadGear().catch((err) => msg($('gearMsg'), 'err', err.message));
    else if (ev.detail === 'crew' && stale) { stale = false; refresh().catch(() => {}); }
  });

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
    /* the department filter: the list of departments comes from the crew itself */
    const depts = [...new Set(state.employees.map((e) => (e.dept || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const dsel = $('fDeptView');
    if (dsel.dataset.have !== depts.join('|')) {
      dsel.dataset.have = depts.join('|');
      dsel.innerHTML = '<option value="">Every department</option>' + depts.map((d) => `<option>${d.replace(/[<&]/g, '')}</option>`).join('');
      if (!depts.includes(deptView)) deptView = '';
      dsel.value = deptView;
    }
    $('deptList').innerHTML = depts.map((d) => `<option value="${d.replace(/[<&"]/g, '')}">`).join('');
    const inDept = (e) => !deptView || (e.dept || '').trim() === deptView;
    const pool = state.employees.filter((e) => !assigned.has(e.badge) && inDept(e));
    $('deptNote').textContent = deptView ? `${state.employees.filter(inDept).length} in ${deptView}` : '';

    $('countChip').textContent = `${state.employees.length} people · ${state.teams.length} teams`;
    $('poolCount').textContent = String(pool.length);
    const poolBox = $('pool');
    poolBox.innerHTML = '';
    if (!pool.length) poolBox.innerHTML = `<div class="empty">${deptView ? `Everyone in ${deptView} is on a team.` : 'Everyone is on a team.'}</div>`;
    for (const e of pool) poolBox.appendChild(personCard(e));
    dropTarget($('poolBucket'), '');

    const box = $('teams');
    box.innerHTML = '';
    if (!state.teams.length) box.innerHTML = '<div class="empty">No teams yet — add one above.</div>';
    const full = allLevels();
    const shown = state.teams.filter((t) => !shiftView || t.shift === shiftView);
    if (state.teams.length && !shown.length) box.innerHTML = `<div class="empty">No ${shiftView === '1' ? '1st' : '2nd'}-shift teams yet — set a team's shift on its card.</div>`;
    for (const b of document.querySelectorAll('#shiftView button')) b.classList.toggle('selected', b.dataset.shift === shiftView);
    for (const t of shown) {
      const card = document.createElement('div');
      card.className = 'bucket';
      const head = document.createElement('div');
      head.className = 'head';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = 'Team ' + t.name;
      const reach = document.createElement('span');
      const anyone = t.members.length || (t.seats || []).length;
      reach.className = 'reach ' + (!anyone ? 'none' : t.reach === full ? 'full' : t.reach.length > 1 ? 'some' : 'none');
      reach.textContent = anyone ? `reaches ${levelsLabel(t.reach)}` : 'nobody assigned';
      head.append(name, reach);
      /* which shift this team works - the dashboard filters on it */
      const shiftRow = document.createElement('div');
      shiftRow.className = 'shiftrow';
      const sel = document.createElement('select');
      sel.className = 'sm';
      sel.title = 'Which shift this team works';
      for (const [v, l] of [['', 'Shift not set'], ['1', '1st shift'], ['2', '2nd shift']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o);
      }
      sel.value = t.shift || '';
      sel.onchange = async () => {
        try { await postJson(`/api/admin/people/teams/${t.id}/shift`, { shift: sel.value }); await refresh(); }
        catch (err) { msg($('teamMsg'), 'err', err.message); }
      };
      shiftRow.appendChild(sel);
      const kit = document.createElement('div');
      kit.className = 'kit';
      kit.textContent = anyone
        ? [t.notes, t.equipment.length ? 'Between them: ' + t.equipment.map(kitName).join(', ') : 'No equipment between them — level A only'].filter(Boolean).join(' · ')
        : (t.notes || '');
      /* the seats from the team sheet: who sits where, and the seats Production fills on the day */
      const seatBox = document.createElement('div');
      seatBox.className = 'seats';
      for (const s of t.seats || []) {
        if (s.onCrewList) continue;                 // a matched person is on the card as themselves
        const row = document.createElement('div');
        row.className = 'seat' + (s.open ? ' open' : ' unmatched');
        row.append(Object.assign(document.createElement('b'), { textContent: s.open ? `${s.dept || 'Open'} — open seat` : s.name }),
          Object.assign(document.createElement('span'), { textContent: [s.role, s.open ? '' : 'not on the crew list'].filter(Boolean).join(' · ') }));
        row.title = s.open ? 'Filled on the day; its equipment counts toward what the team can reach' : 'Add their clock-in number on the crew list and upload the sheet again to put them on the team';
        seatBox.appendChild(row);
      }
      const drop = document.createElement('div');
      drop.className = 'drop';
      if (!t.members.length) drop.innerHTML = `<div class="empty">${(t.seats || []).length ? 'Nobody from the crew list yet — drag someone here' : 'Drag someone here'}</div>`;
      const roleOf = new Map((t.seats || []).filter((s) => s.badge).map((s) => [s.badge, s.role]));
      for (const m of t.members) drop.appendChild(personCard(m, roleOf.get(m.badge) || ''));
      const del = document.createElement('button');
      del.className = 'sm ghost'; del.textContent = 'Delete team'; del.style.marginTop = '8px';
      del.onclick = async () => {
        if (!confirm(`Delete team ${t.name}? Its people go back to the crew list.`)) return;
        try { await apiJson(`/api/admin/people/teams/${t.id}`, { method: 'DELETE' }); await refresh(); }
        catch (err) { msg($('teamMsg'), 'err', err.message); }
      };
      card.append(head, shiftRow, kit, drop, seatBox, del);
      dropTarget(card, String(t.id));
      box.appendChild(card);
    }

    renderEquipPicker();
    renderRules();
    renderReachTable();
    renderPeople();
    for (const sel of document.querySelectorAll('#crewCard select[data-size]')) {
      if (sel.options.length) continue;
      const fresh = sizeSelect(sel.dataset.size, '');
      sel.append(...fresh.options);
      sel.value = '';
    }
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
        (stats.unknownEquipment.length ? `Equipment not recognized, so ignored: ${stats.unknownEquipment.join(', ')}. Add it under the level rules if it should count.` : ''));
      $('fFile').value = '';
      await refresh();
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  };
  /* the team sheet: Team #, Department, Employee, Equipment - one row per seat */
  $('btnTeamUpload').onclick = async () => {
    const file = $('fTeamFile').files[0];
    if (!file) return msg($('teamFileMsg'), 'err', 'Choose the team sheet first');
    if ($('fTeamReplace').checked && !confirm('Remove every team that is not on this sheet? Their people go back to the crew list.')) return;
    msg($('teamFileMsg'), 'warn', `Reading ${file.name}…`);
    try {
      const st = await apiJson(`/api/admin/people/teams/import?replace=${$('fTeamReplace').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await fileToCsv(file) });
      const bits = [
        `${st.created} new, ${st.updated} brought up to date${st.removed ? `, ${st.removed} not on the sheet removed` : ''}.`,
        `${st.matched} of ${st.people} named people found on the crew list${st.open ? `; ${st.open} open seat${st.open === 1 ? '' : 's'}` : ''}.`,
        st.notOnCrewList.length ? `Not on the crew list yet (add their clock-in numbers, then upload again): ${st.notOnCrewList.slice(0, 12).join(', ')}${st.notOnCrewList.length > 12 ? '…' : ''}.` : '',
        st.unknownEquipment.length ? `Equipment not recognized, so not counted toward reach: ${st.unknownEquipment.join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      msg($('teamFileMsg'), st.unknownEquipment.length || st.notOnCrewList.length ? 'warn' : 'ok', `${st.teams} teams from ${file.name}`, bits);
      $('fTeamFile').value = '';
      await refresh();
    } catch (err) { msg($('teamFileMsg'), 'err', 'Upload failed', err.message); }
  };

  $('btnExport').onclick = () => api.download('/api/admin/people/export/employees.csv', 'employees.csv')
    .catch((err) => msg($('uploadMsg'), 'err', err.message));

  $('btnAddPerson').onclick = async () => {
    try {
      const equipment = [...$('equipPicker').querySelectorAll('input:checked')].map((i) => i.value);
      const e = await postJson('/api/admin/people/employees?new=1', {
        badge: $('fBadge').value, name: $('fName').value, dept: $('fDept').value, equipment,
        jacket: $('fAddJacket').value, bibs: $('fAddBibs').value, boots: $('fAddBoots').value,
      });
      msg($('personMsg'), 'ok', `${e.name} added`, `${e.badge}${e.dept ? ' · ' + e.dept : ''} · reaches ${levelsLabel(e.reach)}.`);
      $('fBadge').value = ''; $('fName').value = '';
      for (const id of ['fAddJacket', 'fAddBibs', 'fAddBoots']) $(id).value = '';
      for (const c of $('equipPicker').querySelectorAll('input:checked')) c.checked = false;
      await refresh();
      $('fBadge').focus();
    } catch (err) { msg($('personMsg'), 'err', err.message); }
  };
  $('fName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddPerson').click(); });
  $('fBadge').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fName').focus(); });

  $('btnAddTeam').onclick = async () => {
    try {
      await postJson('/api/admin/people/teams', { name: $('fTeamName').value, notes: $('fTeamNotes').value, shift: $('fTeamShift').value });
      clearMsg($('teamMsg'));
      $('fTeamName').value = ''; $('fTeamNotes').value = '';
      await refresh();
    } catch (err) { msg($('teamMsg'), 'err', err.message); }
  };
  $('fTeamName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddTeam').click(); });
  for (const b of document.querySelectorAll('#shiftView button')) b.onclick = () => { shiftView = b.dataset.shift; render(); };
  $('fDeptView').onchange = () => { deptView = $('fDeptView').value; render(); };

  /* ------------------------------------------------- the counting plan
     Which team takes which aisle, uploaded against a count: teams are the
     site's, the plan is the count's, so the card carries its own picker. */
  let planSessions = [];
  async function loadPlanSessions() {
    planSessions = (await apiJson('/api/admin/sessions')).filter((x) => x.mode !== 'cycle' && !x.practice);
    const sel = $('fPlanSession');
    const prior = sel.value;
    sel.innerHTML = '';
    for (const x of planSessions) {
      const o = document.createElement('option');
      o.value = x.id; o.textContent = `#${x.id} — ${x.name} (${x.status})`;
      sel.appendChild(o);
    }
    if (!planSessions.length) sel.innerHTML = '<option value="">No full counts yet — make one under Settings</option>';
    else if ([...sel.options].some((o) => o.value === prior)) sel.value = prior;
  }
  (() => {
    const box = $('colGuide-plan');
    box.innerHTML = '<div><b>Columns</b> — matched by name, any order, extra columns ignored. &nbsp; <a href="/templates/plan-template.csv" download="plan-template.csv">⬇ Download a sample plan-template.csv</a></div>'
      + '<div class="cols"><code class="req" title="team number">Team (required)</code><code class="req" title="the full aisle code from the bin list">Aisle (required)</code><code class="req" title="A-C, D-F, or A-F">Levels (required)</code><code title="001 end, or far end">Start</code></div>'
      + '<div class="note"><b>Team</b>: team number · <b>Aisle</b>: the full aisle code from the bin list, e.g. F01 — a bare number is refused when it could mean two aisles (A01 / F01) · <b>Levels</b>: which levels the team counts, by equipment: A-C, D-F, or A-F for every level. · <b>Start</b> (optional): <i>far end</i> starts the team at the far end of the aisle — two teams on the same aisle and levels, one from each end, meet in the middle. Upload the count\'s bin list first (Settings → Lists & racking).</div>';
  })();
  $('btnUpload-plan').onclick = async () => {
    const out = $('uploadMsg-plan');
    const sid = Number($('fPlanSession').value) || 0;
    const file = $('fFile-plan').files[0];
    if (!sid) return msg(out, 'err', 'Pick the count the plan is for', 'A full count — make one under Settings → Count setup.');
    if (!file) return msg(out, 'err', 'Choose a file first');
    msg(out, 'warn', `Reading ${file.name}…`);
    try {
      const stats = await apiJson(`/api/admin/sessions/${sid}/master?kind=plan&replace=${$('fReplace-plan').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await fileToCsv(file) });
      const t = stats.totals;
      msg(out, 'ok', `Imported ${stats.rows.toLocaleString()} rows from ${file.name}`,
        `Count #${sid} now has ${t.assignments} planned aisle assignments across ${t.aisles} aisles` +
        (stats.skipped ? ` · ${stats.skipped} row(s) skipped (${stats.skippedNoLevels ? stats.skippedNoLevels + ' with no levels; ' : ''}missing required column, or unknown aisle)` : ''));
      $('fFile-plan').value = '';
    } catch (err) { msg(out, 'err', 'Upload failed', err.message); }
  };

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
  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    // a login with only the Gear sizes tab has no crew list to load
    if (api.canTab('/teams', 'crew') || api.canTab('/teams', 'rules')) refresh().catch(() => show('login'));
    if (document.querySelector('[data-sub="gear"].active')) loadGear().catch((err) => msg($('gearMsg'), 'err', err.message));
    loadPlanSessions().catch(() => {});
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
})();
