/* Supervisor dashboard: sessions, master-data upload, live progress, variance. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('admToken') || '';
  let sessionId = null;

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

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
    $('btnLogout').hidden = which !== 'main';
    $('sessionChip').hidden = which !== 'main';
  }

  function logout() {
    token = '';
    sessionStorage.removeItem('admToken');
    show('login');
  }

  async function login() {
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: $('fPassword').value }),
      });
      if (!res.ok) throw new Error('Wrong password');
      token = (await res.json()).token;
      sessionStorage.setItem('admToken', token);
      $('fPassword').value = '';
      show('main');
      await loadSessions();
    } catch (err) {
      msg($('loginMsg'), 'err', err.message);
    }
  }

  async function loadSessions() {
    const sessions = await apiJson('/api/admin/sessions');
    const sel = $('fSessionPick');
    const prior = sessionId;
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name} (${s.status}${s.blind ? ', blind' : ''})`;
      sel.appendChild(o);
    }
    if (!sessions.length) {
      sel.innerHTML = '<option value="">No sessions yet — create one below</option>';
      sessionId = null;
      return;
    }
    sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
    sel.value = String(sessionId);
    $('sessionChip').textContent = 'Session #' + sessionId;
    await refresh();
  }

  function table(el, columns, rows, renderRow) {
    el.innerHTML = '';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.num) th.className = 'num';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    for (const r of rows) tbody.appendChild(renderRow(r));
    el.append(thead, tbody);
  }

  const cell = (text, cls) => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  };

  async function refresh() {
    if (!sessionId) return;
    const p = await apiJson(`/api/admin/sessions/${sessionId}/progress`);
    const pct = p.locations_total ? Math.round((p.locations_counted / p.locations_total) * 100) : 0;
    $('stats').innerHTML = '';
    const stats = [
      [p.lines.toLocaleString(), 'Count lines'],
      [`${p.locations_counted.toLocaleString()} / ${p.locations_total.toLocaleString()}`, `Locations counted (${pct}%)`],
      [p.counters, 'Counters active'],
      [p.overrides, 'Exception lines'],
    ];
    for (const [n, l] of stats) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      $('stats').appendChild(d);
    }

    table($('zoneTable'),
      [{ label: 'Zone' }, { label: 'Counted', num: true }, { label: 'Total', num: true }, { label: 'Progress' }],
      p.byZone,
      (z) => {
        const tr = document.createElement('tr');
        tr.append(cell(z.zone), cell(z.counted, 'num'), cell(z.total, 'num'));
        const td = document.createElement('td');
        const bar = document.createElement('div');
        bar.className = 'bar';
        const i = document.createElement('i');
        i.style.width = (z.total ? Math.round((z.counted / z.total) * 100) : 0) + '%';
        bar.appendChild(i);
        td.appendChild(bar);
        tr.appendChild(td);
        return tr;
      });

    table($('counterTable'),
      [{ label: 'Counter' }, { label: 'Lines', num: true }, { label: 'Last scan' }],
      p.byCounter,
      (c) => {
        const tr = document.createElement('tr');
        tr.append(cell(c.counter), cell(c.lines, 'num'),
          cell(c.last_scan ? new Date(c.last_scan).toLocaleString() : '—'));
        return tr;
      });

    const only = $('fOnlyVariance').checked ? '?only=variance&limit=500' : '?limit=500';
    const rows = await apiJson(`/api/admin/sessions/${sessionId}/variance${only}`);
    table($('varianceTable'),
      [{ label: 'Location' }, { label: 'SKU' }, { label: 'Description' },
       { label: 'Expected', num: true }, { label: 'Counted', num: true },
       { label: 'Variance', num: true }, { label: 'Status' }],
      rows,
      (r) => {
        const tr = document.createElement('tr');
        tr.append(cell(r.location_code), cell(r.sku), cell(r.description),
          cell(r.expected_qty, 'num'), cell(r.counted_qty, 'num'), cell(r.variance_qty, 'num'));
        const td = document.createElement('td');
        const tag = document.createElement('span');
        tag.className = 'tag ' + r.status;
        tag.textContent = r.status;
        td.appendChild(tag);
        tr.appendChild(td);
        return tr;
      });
    $('varianceNote').textContent = rows.length >= 500
      ? 'Showing the first 500 rows — export the CSV for the full list.'
      : `${rows.length} row(s).`;
    $('refreshedAt').textContent = ' Updated ' + new Date().toLocaleTimeString();
  }

  async function download(path, filename) {
    const res = await api(path);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------- wiring
  $('btnLogin').onclick = login;
  $('fPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('btnLogout').onclick = logout;
  $('btnRefresh').onclick = () => refresh().catch((e) => alert(e.message));
  $('fOnlyVariance').onchange = () => refresh();
  $('fSessionPick').onchange = (e) => {
    sessionId = Number(e.target.value) || null;
    $('sessionChip').textContent = 'Session #' + sessionId;
    refresh();
  };

  $('btnCreate').onclick = async () => {
    try {
      const s = await apiJson('/api/admin/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('fNewName').value,
          blind: $('fBlind').checked,
          requireLpn: $('fRequireLpn').checked,
          allowOverride: $('fAllowOverride').checked,
        }),
      });
      $('fNewName').value = '';
      sessionId = s.id;
      msg($('sessionMsg'), 'ok', `Created session #${s.id}. Upload its master data next.`);
      await loadSessions();
    } catch (err) {
      msg($('sessionMsg'), 'err', err.message);
    }
  };

  const setStatus = async (status) => {
    if (!sessionId) return;
    try {
      await apiJson(`/api/admin/sessions/${sessionId}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      msg($('sessionMsg'), 'ok', `Session #${sessionId} is now ${status}.`);
      await loadSessions();
    } catch (err) {
      msg($('sessionMsg'), 'err', err.message);
    }
  };
  $('btnCloseSession').onclick = () => setStatus('closed');
  $('btnReopenSession').onclick = () => setStatus('open');

  $('btnUpload').onclick = async () => {
    const file = $('fFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a CSV file first');
    if (!sessionId) return msg($('uploadMsg'), 'err', 'Create or select a session first');
    msg($('uploadMsg'), 'warn', `Uploading ${file.name}…`);
    try {
      const text = await file.text();
      const kind = $('fKind').value;
      const replace = $('fReplace').checked ? '1' : '0';
      const stats = await apiJson(
        `/api/admin/sessions/${sessionId}/master?kind=${kind}&replace=${replace}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text }
      );
      msg($('uploadMsg'), 'ok',
        `Imported ${stats.rows.toLocaleString()} rows from ${file.name}`,
        `Session totals — locations: ${stats.totals.locations.toLocaleString()}, ` +
        `items: ${stats.totals.items.toLocaleString()}, ` +
        `barcodes: ${stats.totals.barcodes.toLocaleString()}, ` +
        `expected lines: ${stats.totals.expected.toLocaleString()}` +
        (stats.skipped ? ` · ${stats.skipped} row(s) skipped (missing location or sku)` : ''));
      await refresh();
    } catch (err) {
      msg($('uploadMsg'), 'err', 'Upload failed', err.message);
    }
  };

  $('btnExportVariance').onclick = () =>
    download(`/api/admin/sessions/${sessionId}/export/variance.csv`, `variance-session-${sessionId}.csv`);
  $('btnExportCounts').onclick = () =>
    download(`/api/admin/sessions/${sessionId}/export/counts.csv`, `counts-session-${sessionId}.csv`);

  // ---------------------------------------------------------------- boot
  (async () => {
    if (!token) return show('login');
    try {
      await apiJson('/api/admin/sessions');
      show('main');
      await loadSessions();
    } catch {
      show('login');
    }
  })();
  setInterval(() => { if (token && sessionId) refresh().catch(() => {}); }, 30000);
})();
