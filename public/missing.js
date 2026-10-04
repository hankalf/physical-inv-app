/* Not in Location: pallets the system has lost track of, watched for by every
   scanner and ticked off here when they turn up. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, table, cell, tag, button, fileToCsv } = window.appUi;
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);

  let status = 'missing';
  let rows = [];

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }

  async function refresh() {
    const d = await apiJson(`/api/admin/missing${status ? '?status=' + status : ''}`);
    rows = d.rows;
    $('msMissing').textContent = d.summary.missing.toLocaleString();
    $('msFound').textContent = d.summary.found.toLocaleString();
    $('msClosed').textContent = d.summary.closed.toLocaleString();
    for (const b of document.querySelectorAll('#msFilter button')) b.classList.toggle('selected', b.dataset.status === status);
    draw();
  }

  function draw() {
    const q = $('fMsSearch').value.trim().toUpperCase();
    const shown = q ? rows.filter((r) => [r.pallet_id, r.sku, r.description, r.last_location, r.found_bin, r.lot].some((v) => String(v || '').toUpperCase().includes(q))) : rows;
    table($('msTable'),
      [{ label: 'Pallet' }, { label: 'Item' }, { label: 'Description' }, { label: 'Qty', num: true }, { label: 'Lot' }, { label: 'Last known location' },
        { label: 'Status' }, { label: 'Found' }, { label: 'Note' }, { label: 'Listed' }, { label: '' }],
      shown,
      (r) => {
        const tr = document.createElement('tr');
        const st = document.createElement('td');
        st.appendChild(tag(r.status === 'found' ? 'done' : r.status === 'closed' ? 'off' : 'open'));
        st.append(' ' + (r.status === 'found' ? 'found' : r.status === 'closed' ? (r.outcome ? `closed · ${r.outcome}` : 'closed') : 'missing'));
        const found = cell(r.status === 'found'
          ? `${r.found_bin || '—'}${r.found_team ? ` · team ${r.found_team}` : ''}${r.found_device ? ` · ${r.found_device}` : ''}${r.found_at ? ' · ' + new Date(r.found_at).toLocaleString() : ''}${r.found_how === 'moved' ? ' · while moving' : r.found_how === 'by hand' ? ' · by hand' : ''}`
          : '—', r.status === 'found' ? 'found wrap' : '');
        const act = document.createElement('td');
        if (r.status === 'missing') {
          act.appendChild(button('Found in…', 'sm primary', async () => {
            const bin = prompt(`Where was ${r.pallet_id} found? (bin code)`);
            if (bin === null) return;
            try { await postJson(`/api/admin/missing/${r.id}/found`, { bin }); await refresh(); } catch (err) { msg($('msMsg'), 'err', err.message); }
          }));
          act.appendChild(button('Close', 'sm', async () => {
            const outcome = prompt(`Close ${r.pallet_id} — what happened? (written off, shipped, never existed…)`);
            if (outcome === null) return;
            try { await postJson(`/api/admin/missing/${r.id}/close`, { outcome }); await refresh(); } catch (err) { msg($('msMsg'), 'err', err.message); }
          }));
        } else {
          act.appendChild(button('Back on the list', 'sm', async () => {
            try { await postJson(`/api/admin/missing/${r.id}/close`, { reopen: true }); await refresh(); } catch (err) { msg($('msMsg'), 'err', err.message); }
          }));
        }
        tr.append(cell(r.pallet_id), cell(r.sku || '—'), cell(r.description || '—', 'wrap'), cell(r.qty ?? '—', 'num'), cell(r.lot || '—'),
          cell(r.last_location || '—'), st, found, cell(r.note || '', 'wrap'), cell(new Date(r.created_at).toLocaleDateString()), act);
        return tr;
      },
      status === 'missing' ? 'Nothing missing — every pallet is where it should be.' : 'Nothing here.');
  }

  for (const b of document.querySelectorAll('#msFilter button')) b.onclick = () => { status = b.dataset.status; refresh().catch(() => {}); };
  $('fMsSearch').addEventListener('input', draw);

  $('btnMsUpload').onclick = async () => {
    const file = $('fMsFile').files[0];
    if (!file) return msg($('msMsg'), 'err', 'Choose a file first');
    try {
      const text = await fileToCsv(file);
      const res = await api.call(`/api/admin/missing/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      const r = await res.json();
      msg($('msMsg'), 'ok', `${r.added} added, ${r.updated} updated — from ${file.name}.`, 'Every scanner now watches for them.');
      $('fMsFile').value = '';
      await refresh();
    } catch (err) { msg($('msMsg'), 'err', 'That file did not load', err.message); }
  };
  $('btnMsAdd').onclick = async () => {
    try {
      await postJson('/api/admin/missing', { pallet: $('fMsPallet').value, sku: $('fMsSku').value, description: $('fMsDesc').value, qty: $('fMsQty').value, last: $('fMsLast').value });
      for (const id of ['fMsPallet', 'fMsSku', 'fMsDesc', 'fMsQty', 'fMsLast']) $(id).value = '';
      msg($('msMsg'), 'ok', 'Added.');
      await refresh();
    } catch (err) { msg($('msMsg'), 'err', err.message); }
  };
  $('btnMsCsv').onclick = () => api.download('/api/admin/missing.csv', 'not-in-location.csv');

  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    refresh().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token) refresh().catch(() => {}); }, 20000);
})();
