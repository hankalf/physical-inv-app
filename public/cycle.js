/* Cycle counts: the programme, its coverage, and the bins going out today. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('admToken') || '';
  let sessions = [];
  let sessionId = null;

  async function api(path, options = {}) {
    const res = await fetch(path, { ...options, headers: { authorization: 'Bearer ' + token, ...(options.headers || {}) }, cache: 'no-store' });
    if (res.status === 401) { logout(); throw new Error('Session expired — sign in again'); }
    if (!res.ok) {
      let m = res.status + ' ' + res.statusText;
      try { m = (await res.json()).error || m; } catch { /* keep status text */ }
      throw new Error(m);
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
  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('btnLogout').hidden = which !== 'main';
    $('clockChip').hidden = which !== 'main';
  }
  function logout() { token = ''; sessionStorage.removeItem('admToken'); show('login'); }
  const needSession = (el) => {
    if (sessionId) return true;
    msg(el, 'err', 'Create a cycle-count programme first', 'One programme runs for the year — you generate a batch out of it each day.');
    return false;
  };

  async function login() {
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('fPassword').value, name: $('fWho').value }) });
      if (!res.ok) throw new Error('Wrong password');
      token = (await res.json()).token;
      sessionStorage.setItem('admToken', token);
      $('fPassword').value = '';
      show('main');
      await loadSessions();
    } catch (err) { msg($('loginMsg'), 'err', err.message); }
  }

  /* ------------------------------------------------------------ table helper */
  const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; return td; };
  function table(el, columns, rows, renderRow, empty) {
    el.innerHTML = '';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of columns) { const th = document.createElement('th'); th.textContent = c.label; if (c.num) th.className = 'num'; hr.appendChild(th); }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    if (!rows.length) { const tr = document.createElement('tr'); const td = cell(empty); td.colSpan = columns.length; td.className = 'hint'; tr.appendChild(td); tbody.appendChild(tr); }
    for (const r of rows) tbody.appendChild(renderRow(r));
    el.append(thead, tbody);
  }

  /* ------------------------------------------------------------ sessions */
  async function loadSessions() {
    const all = await apiJson('/api/admin/sessions');
    sessions = all.filter((s) => s.mode === 'cycle');
    const sel = $('fSessionPick');
    const prior = sessionId;
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name}${s.status === 'closed' ? ' (closed)' : ''}`;
      sel.appendChild(o);
    }
    const has = sessions.length > 0;
    $('noSessions').hidden = has;
    for (const id of ['dataCard', 'coverageCard', 'generateCard', 'batchCard', 'openCard']) $(id).hidden = !has;
    if (!has) { sessionId = null; sel.innerHTML = '<option value="">No cycle-count programme yet</option>'; return; }
    sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
    sel.value = String(sessionId);
    const s = sessions.find((x) => x.id === sessionId);
    $('btnCloseSession').textContent = s.status === 'closed' ? 'Reopen' : 'Close';
    await refresh();
  }

  /* ------------------------------------------------------------ the numbers */
  async function refresh() {
    if (!sessionId) return;
    const days = $('fCovDays').value;
    const data = await apiJson(`/api/admin/sessions/${sessionId}/cycle/batches?days=${days}`);
    const c = data.coverage;
    const pct = c.bins ? Math.round((c.recent / c.bins) * 100) : 0;
    $('clockChip').textContent = `${data.siteTimezone} · ${data.siteDate}`;
    $('covBar').style.width = pct + '%';
    $('covBarText').textContent = `${pct}% of ${c.bins.toLocaleString()} bins counted in the last ${c.days} days`;
    $('cycleSub').textContent = data.batches.length ? `${data.batches.length} batch(es)` : 'no batches yet';

    $('cycleStats').innerHTML = '';
    for (const [n, l] of [
      [`${c.recent.toLocaleString()} / ${c.bins.toLocaleString()}`, `Counted within ${c.days} days`],
      [c.never.toLocaleString(), 'Never counted'],
      [c.oldest ? new Date(c.oldest).toLocaleDateString() : '—', 'Oldest count on record'],
      [c.openTasks.toLocaleString(), 'Bins on open lists'],
      [c.bins && c.days ? Math.ceil((c.bins - c.recent) / Math.max(1, c.days)) : 0, 'Bins/day to stay covered'],
    ]) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      $('cycleStats').appendChild(d);
    }

    table($('batchTable'),
      [{ label: 'Due' }, { label: 'Batch' }, { label: 'Picked by' }, { label: 'Scope' }, { label: 'Bins', num: true }, { label: 'Done', num: true }, { label: 'Progress' }, { label: 'Teams' }, { label: '' }],
      data.batches,
      (b) => {
        const tr = document.createElement('tr');
        let scope = 'whole site';
        try { const s2 = JSON.parse(b.scope || '{}'); scope = [s2.zone, s2.aisle, s2.levels].filter(Boolean).join(' · ') || 'whole site'; } catch { /* keep default */ }
        tr.append(cell(b.due_date));
        const tdName = document.createElement('td');
        tdName.append(b.name);
        if (b.auto) { const t = document.createElement('span'); t.className = 'tag auto'; t.textContent = 'auto'; t.style.marginLeft = '6px'; tdName.appendChild(t); }
        tr.append(tdName, cell(data.strategies[b.strategy] || b.strategy), cell(scope), cell(b.bins, 'num'), cell(b.done, 'num'));
        const td = document.createElement('td');
        const bar = document.createElement('div'); bar.className = 'bar';
        const i = document.createElement('i'); i.style.width = (b.bins ? Math.round((b.done / b.bins) * 100) : 0) + '%';
        bar.appendChild(i); td.appendChild(bar); tr.appendChild(td);
        tr.append(cell(b.teams || '—'));
        const tdDel = document.createElement('td');
        const del = document.createElement('button');
        del.className = 'sm danger'; del.textContent = b.done ? 'Clear rest' : 'Remove';
        del.onclick = async () => {
          if (!confirm(`${b.done ? 'Remove the bins still open in' : 'Remove'} "${b.name}"? Counts already recorded are kept.`)) return;
          try { await apiJson(`/api/admin/sessions/${sessionId}/cycle/batches/${b.id}`, { method: 'DELETE' }); await refresh(); }
          catch (err) { msg($('cycleMsg'), 'err', err.message); }
        };
        tdDel.appendChild(del); tr.appendChild(tdDel);
        return tr;
      }, 'No batches yet — generate one above.');

    const open = await apiJson(`/api/admin/sessions/${sessionId}/cycle/open`);
    $('openSub').textContent = open.length ? `${open.length} waiting to be counted` : 'nothing outstanding';
    table($('openTable'),
      [{ label: 'Bin' }, { label: 'Aisle' }, { label: 'Level' }, { label: 'Zone' }, { label: 'Batch' }, { label: 'Assigned to' }, { label: 'Status' }, { label: 'Why it was picked' }],
      open.slice(0, 200),
      (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(r.bin), cell(r.aisle || '—'), cell(r.level || '—'), cell(r.zone || '—'), cell(r.batch || '—'), cell(r.team || 'any team'), cell(r.status), cell(r.detail || ''));
        return tr;
      }, 'Every bin that was sent out has been counted.');

    const s = sessions.find((x) => x.id === sessionId);
    let plan = null;
    try { plan = s.cycle_schedule ? JSON.parse(s.cycle_schedule) : null; } catch { /* ignore */ }
    $('fCycAuto').checked = !!plan;
    if (plan) {
      $('fCycEvery').value = plan.every; $('fCycSchedBins').value = plan.bins;
      $('fCycHour').value = plan.hour; $('fCycWeekday').value = String(plan.weekday ?? 1);
      if (plan.strategy) $('fCycStrategy').value = plan.strategy;
    }
  }

  /* ------------------------------------------------------------ actions */
  const opts = () => ({
    target: Number($('fCycBins').value), strategy: $('fCycStrategy').value,
    zone: $('fCycZone').value, aisle: $('fCycAisle').value, levels: $('fCycLevels').value, team: $('fCycTeam').value,
  });

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

  async function upload(kind, text, label) {
    msg($('uploadMsg'), 'warn', `Uploading ${label}…`);
    try {
      const stats = await apiJson(`/api/admin/sessions/${sessionId}/master?kind=${kind}&replace=${$('fReplace').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      const t = stats.totals;
      msg($('uploadMsg'), 'ok', `Imported ${stats.rows.toLocaleString()} rows from ${label}`,
        `${t.bins.toLocaleString()} bins in ${t.aisles} aisles · ${t.pallets.toLocaleString()} pallets on the report` +
        (stats.withDates ? ` · ${stats.withDates.toLocaleString()} bins carry a last-counted date` : '') +
        (stats.excluded ? ` · ${stats.excluded} counted-by-hand bins left out` : ''));
      await refresh();
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  }

  $('btnLogin').onclick = login;
  $('fPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('btnLogout').onclick = logout;
  $('fSessionPick').onchange = (e) => { sessionId = Number(e.target.value) || null; refresh(); };
  $('fCovDays').onchange = refresh;

  $('btnCreate').onclick = async () => {
    try {
      const s = await postJson('/api/admin/sessions', { name: $('fNewName').value, mode: 'cycle' });
      $('fNewName').value = '';
      sessionId = s.id;
      msg($('sessionMsg'), 'ok', `Created “${s.name}”.`, 'Upload the bin list and the inventory report next.');
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnCloseSession').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const next = s.status === 'closed' ? 'open' : 'closed';
    if (next === 'closed' && !confirm('Close this programme? Scanners will stop being able to send counts.')) return;
    try { await postJson(`/api/admin/sessions/${sessionId}/status`, { status: next }); await loadSessions(); }
    catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };

  $('btnUpload').onclick = async () => {
    const file = $('fFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a file first');
    if (!needSession($('uploadMsg'))) return;
    try { await upload($('fKind').value, await fileToCsv(file), file.name); $('fFile').value = ''; }
    catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  };
  $('btnLoadSiteBins').onclick = async () => {
    if (!needSession($('uploadMsg'))) return;
    const res = await fetch('/templates/front-royal-bins.csv');
    await upload('bins', await res.text(), 'the Front Royal bin list');
  };

  $('btnCycPreview').onclick = async () => {
    if (!needSession($('cycleMsg'))) return;
    try {
      const r = await postJson(`/api/admin/sessions/${sessionId}/cycle/preview`, opts());
      const oldest = r.picked[0], newest = r.picked[r.picked.length - 1];
      msg($('cycleMsg'), 'warn', `${r.picked.length} bins would be picked (${r.available.toLocaleString()} match that scope)`,
        r.picked.length ? `From ${oldest.code} (${oldest.last_counted ? 'last counted ' + oldest.last_counted.slice(0, 10) : 'never counted'}) to ${newest.code}. Nothing generated yet.` : '');
    } catch (err) { msg($('cycleMsg'), 'err', err.message); }
  };
  $('btnCycGenerate').onclick = async () => {
    if (!needSession($('cycleMsg'))) return;
    try {
      const r = await postJson(`/api/admin/sessions/${sessionId}/cycle/batches`, opts());
      msg($('cycleMsg'), 'ok', `Generated ${r.created} bins for ${r.batch.due_date}.`, 'They are on the scanners now — teams see them at sign-on or after a refresh.');
      await refresh();
    } catch (err) { msg($('cycleMsg'), 'err', err.message); }
  };
  $('btnCycSchedule').onclick = async () => {
    if (!needSession($('cycleMsg'))) return;
    try {
      const body = $('fCycAuto').checked
        ? { every: $('fCycEvery').value, bins: Number($('fCycSchedBins').value), strategy: $('fCycStrategy').value,
            hour: Number($('fCycHour').value), weekday: Number($('fCycWeekday').value),
            zone: $('fCycZone').value, aisle: $('fCycAisle').value, levels: $('fCycLevels').value }
        : {};
      await postJson(`/api/admin/sessions/${sessionId}/cycle/schedule`, body);
      msg($('cycleMsg'), 'ok', $('fCycAuto').checked
        ? `Saved: ${$('fCycSchedBins').value} bins every ${$('fCycEvery').value === 'week' ? $('fCycWeekday').selectedOptions[0].textContent : 'weekday'} from ${$('fCycHour').value}:00 site time.`
        : 'Automatic generation turned off.');
      await loadSessions();
    } catch (err) { msg($('cycleMsg'), 'err', err.message); }
  };
  $('btnExportCoverage').onclick = async () => {
    const res = await api(`/api/admin/sessions/${sessionId}/export/coverage.csv`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `bin-coverage-${sessionId}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  (async () => {
    if (!token) return show('login');
    try { await apiJson('/api/admin/sessions'); show('main'); await loadSessions(); }
    catch { show('login'); }
  })();
  setInterval(() => { if (token && sessionId) refresh().catch(() => {}); }, 30000);
})();
