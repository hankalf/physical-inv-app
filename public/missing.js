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

  /* ------------------------------------------------------------ the find desk
     The list as a desk: the next pallet to look for, what it is, where it was
     last seen, and the pallet system framed under it, the way the move desk
     works on Front bins. */
  let deskList = [];
  let deskAt = 0;
  let deskUrl = '';
  let deskMode = 'frame';
  let deskUrlLoaded = '';
  const deskLink = (m) => api.fillUrl(deskUrl, m ? { pallet: m.pallet_id, last: m.last_location || '', bin: m.last_location || '', from: m.last_location || '', to: '' } : {});
  function renderDesk() {
    const m = deskList[deskAt] || null;
    $('fdDeskNone').hidden = !!m;
    $('fdDeskMove').hidden = !m;
    $('fdDeskPrev').disabled = deskAt <= 0;
    $('fdDeskNext').disabled = deskAt >= deskList.length - 1;
    $('fdDeskFound').disabled = !m || !api.can('missing');
    $('fdDeskClose').disabled = !m || !api.can('missing');
    $('fdDeskBin').disabled = !m;
    $('fdDeskCount').textContent = deskList.length ? `${deskAt + 1} of ${deskList.length} missing` : '';
    if (m) {
      $('fdDeskPallet').textContent = m.pallet_id;
      $('fdDeskLast').textContent = m.last_location || '—';
      $('fdDeskMeta').textContent = [m.description, m.sku ? `item ${m.sku}` : '', m.qty != null ? `qty ${m.qty}` : '', m.lot ? `lot ${m.lot}` : '', m.note].filter(Boolean).join(' · ') || 'no description';
    }
    const link = deskLink(m);
    const asWindow = deskMode === 'window';
    $('fdDeskUrlNote').textContent = deskUrl ? `Pallet system: ${deskUrl}${asWindow ? ' · opens in its own window' : deskMode === 'proxy' ? ' · shown through this app' : ''}` : 'No pallet system address set — an admin can set it under Settings → Integrations → Pallet system. The strip above works without it.';
    $('fdDeskOpen').hidden = !deskUrl || asWindow;
    $('fdDeskOpen').href = link || '#';
    $('fdDeskWindow').hidden = !deskUrl || !asWindow;
    $('fdDeskWindow').disabled = !m;
    $('fdDeskWindow').textContent = m ? `Open ${m.pallet_id} in the pallet system ↗` : 'Open the pallet system ↗';
    $('fdDeskWindowNote').hidden = !deskUrl || !asWindow;
    $('fdDeskWide').hidden = !deskUrl || asWindow;
    $('fdDeskWrap').classList.toggle('none', !deskUrl || asWindow);
    // framed: the frame follows the pallet when the address carries placeholders;
    // shown through this app, the frame opens the system's page under /ps on this site
    const src = deskMode === 'proxy' ? api.proxiedPath(link) : link;
    if (deskUrl && !asWindow && src !== deskUrlLoaded) { deskUrlLoaded = src; $('fdDeskFrame').src = src; }
  }
  $('fdDeskWindow').onclick = () => { const m = deskList[deskAt]; if (m && !api.openPalletSystem(deskLink(m))) msg($('fdDeskMsg'), 'err', 'The browser blocked the window', 'Allow pop-ups for this site and try again.'); };
  async function refreshDesk() {
    try { const ps = await apiJson('/api/admin/pallet-system'); deskUrl = ps.url || ''; deskMode = ['window', 'proxy'].includes(ps.mode) ? ps.mode : 'frame'; } catch { deskUrl = ''; }
    // through this app: a ticket, so the pages under /ps open for this browser
    if (deskUrl && deskMode === 'proxy') await api.post('/api/admin/pallet-system/ticket', {}).catch(() => {});
    const d = await apiJson('/api/admin/missing?status=missing');
    deskList = d.rows || [];
    if (deskAt >= deskList.length) deskAt = Math.max(0, deskList.length - 1);
    renderDesk();
  }
  $('fdDeskPrev').onclick = () => { deskAt = Math.max(0, deskAt - 1); renderDesk(); };
  $('fdDeskNext').onclick = () => { deskAt = Math.min(deskList.length - 1, deskAt + 1); renderDesk(); };
  $('fdDeskFound').onclick = async () => {
    const m = deskList[deskAt];
    if (!m) return;
    const bin = $('fdDeskBin').value.trim();
    if (!bin) { msg($('fdDeskMsg'), 'err', 'Type the bin it is in first'); $('fdDeskBin').focus(); return; }
    try {
      await postJson(`/api/admin/missing/${m.id}/found`, { bin });
      $('fdDeskBin').value = '';
      msg($('fdDeskMsg'), 'ok', `${m.pallet_id} found in ${bin.toUpperCase()}.`);
      await refresh();
    } catch (err) { msg($('fdDeskMsg'), 'err', err.message); }
  };
  $('fdDeskBin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fdDeskFound').click(); });
  $('fdDeskClose').onclick = async () => {
    const m = deskList[deskAt];
    if (!m) return;
    const outcome = prompt(`Close ${m.pallet_id} — what happened? (written off, shipped, never existed…)`);
    if (outcome === null) return;
    try { await postJson(`/api/admin/missing/${m.id}/close`, { outcome }); msg($('fdDeskMsg'), 'ok', `${m.pallet_id} closed.`); await refresh(); } catch (err) { msg($('fdDeskMsg'), 'err', err.message); }
  };
  const WIDE = 'finddesk:wide';
  const setWide = (w) => { $('fdDeskWrap').classList.toggle('wide', w); $('fdDeskWide').textContent = w ? 'Handheld size' : 'Full width'; try { localStorage.setItem(WIDE, w ? '1' : ''); } catch { /* private window */ } };
  try { setWide(localStorage.getItem(WIDE) === '1'); } catch { setWide(false); }
  $('fdDeskWide').onclick = () => setWide(!$('fdDeskWrap').classList.contains('wide'));

  async function refresh() {
    const d = await apiJson(`/api/admin/missing${status ? '?status=' + status : ''}`);
    rows = d.rows;
    refreshDesk().catch(() => {});
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
