/* Front bins: the list of front-placed bins, and the pallets to move back
   behind them - built from the report or uploaded, handed to the guns as a
   job of their own, and watched here as it gets done. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, table, cell, tag, fileToCsv } = window.appUi;
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);

  /* No count to pick: this is a job on the warehouse. The server works from the
     site's current bin list and says which one that is. */
  let ready = false;
  let mvStatus = '';
  const F = '/api/admin/front';

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }
  const needSession = (el) => { if (ready) return true; msg(el, 'err', 'No bin list yet', 'Upload the site\'s bin list under Settings → Lists & racking first.'); return false; };

  async function loadStatus() {
    const st = await apiJson(`${F}/status`);
    ready = !!st.ready;
    $('frontRef').hidden = !ready;
    $('frontRef').textContent = ready ? `bin list: ${st.binList.bins.toLocaleString()} bins, ${st.binList.pallets.toLocaleString()} pallets on the report (from “${st.binList.from}”)` : '';
    $('frontNotReady').hidden = ready;
    $('frontNotReady').textContent = ready ? '' : `Nothing to work from yet — ${st.why}.`;
    if (ready) await refresh();
    await refreshDesk().catch(() => {});
  }

  async function refresh() {
    if (!ready) return;
    const d = await apiJson(`${F}/moves${mvStatus ? '?status=' + mvStatus : ''}`);
    $('mvOpen').textContent = d.summary.open.toLocaleString();
    $('mvDone').textContent = d.summary.done.toLocaleString();
    $('mvSkipped').textContent = d.summary.skipped.toLocaleString();
    $('mvAisles').textContent = d.summary.aisles.toLocaleString();
    for (const b of document.querySelectorAll('#mvFilter button')) b.classList.toggle('selected', b.dataset.status === mvStatus);
    table($('mvTable'),
      [{ label: 'Aisle' }, { label: 'Pallet' }, { label: 'From (front)' }, { label: 'To (behind)' }, { label: 'Level' }, { label: 'Status' }, { label: 'Team' }, { label: 'When' }, { label: 'Note' }],
      d.moves,
      (r) => {
        const tr = document.createElement('tr');
        const st = document.createElement('td');
        st.appendChild(tag(r.status === 'done' ? 'done' : r.status === 'skipped' ? 'blocked' : 'open'));
        st.append(' ' + (r.status === 'done' ? 'moved' : r.status === 'skipped' ? 'skipped' : 'to move'));
        tr.append(cell(r.aisle || '—'), cell(r.pallet_id), cell(r.from_bin), cell(r.to_bin), cell(r.level || '—'), st,
          cell(r.team ? `team ${r.team}` : '—'), cell(r.done_at ? new Date(r.done_at).toLocaleString() : '—'),
          cell(r.status === 'skipped' ? r.reason || '' : r.actual_bin && r.actual_bin !== r.to_bin ? `put in ${r.actual_bin}` : r.source === 'upload' ? 'uploaded' : '', 'wrap'));
        return tr;
      }, mvStatus ? 'Nothing with that status.' : 'No moves yet — build the list from the report, or upload one.');
  }

  for (const b of document.querySelectorAll('#mvFilter button')) b.onclick = () => { mvStatus = b.dataset.status; refresh(); };

  /* ------------------------------------------------------------ the desk
     The next pallet to move, from the open list, and the pallet system's own
     screen framed beneath it: the move is made in the system, then ticked off
     here. The address comes from Settings → Advanced → Pallet system; a system
     that refuses to be framed is a click away in a new tab instead. */
  let deskList = [];
  let deskAt = 0;
  let deskUrl = '';
  let deskUrlLoaded = '';
  function renderDesk() {
    const m = deskList[deskAt] || null;
    $('deskNone').hidden = !!m || !ready;
    $('deskMove').hidden = !m;
    $('deskPrev').disabled = deskAt <= 0;
    $('deskNext').disabled = deskAt >= deskList.length - 1;
    $('deskDone').disabled = !m || !api.can('front');
    $('deskSkip').disabled = !m || !api.can('front');
    $('deskCount').textContent = deskList.length ? `${deskAt + 1} of ${deskList.length} waiting` : '';
    if (m) {
      $('deskPallet').textContent = m.pallet_id;
      $('deskFrom').textContent = m.from_bin;
      $('deskTo').textContent = m.to_bin;
      $('deskMeta').textContent = `aisle ${m.aisle || '—'}${m.level ? ' · level ' + m.level : ''}${m.source === 'upload' ? ' · from the uploaded list' : ' · from the report'}`;
    }
    $('deskUrlNote').textContent = deskUrl ? `Pallet system: ${deskUrl}` : 'No pallet system address set — an admin can set it under Settings → Advanced → Pallet system. The strip above works without it.';
    $('deskOpen').hidden = !deskUrl;
    $('deskOpen').href = deskUrl || '#';
    $('deskWrap').classList.toggle('none', !deskUrl);
    if (deskUrl && deskUrl !== deskUrlLoaded) { deskUrlLoaded = deskUrl; $('deskFrame').src = deskUrl; }
  }
  async function refreshDesk() {
    try { deskUrl = (await apiJson('/api/admin/pallet-system')).url || ''; } catch { deskUrl = ''; }
    if (ready) {
      const d = await apiJson(`${F}/moves?status=open`);
      deskList = d.moves || [];
      if (deskAt >= deskList.length) deskAt = Math.max(0, deskList.length - 1);
    } else deskList = [];
    $('deskNotReady').hidden = ready;
    $('deskNotReady').textContent = ready ? '' : 'Nothing to work from yet — upload the site\'s bin list under Settings → Lists & racking first.';
    renderDesk();
  }
  $('deskPrev').onclick = () => { deskAt = Math.max(0, deskAt - 1); renderDesk(); };
  $('deskNext').onclick = () => { deskAt = Math.min(deskList.length - 1, deskAt + 1); renderDesk(); };
  async function finishFromDesk(kind) {
    const m = deskList[deskAt];
    if (!m) return;
    const st = await apiJson(`${F}/status`);
    const sid = st.binList && st.binList.sessionId;
    try {
      const body = kind === 'skip' ? { reason: prompt('Why is it being skipped?', '') || 'skipped from the desk' } : {};
      await postJson(`/api/admin/sessions/${sid}/moves/${m.id}/${kind}`, body);
      msg($('deskMsg'), 'ok', kind === 'skip' ? `${m.pallet_id} skipped.` : `${m.pallet_id} marked moved to ${m.to_bin}.`, 'The next one is up.');
      await refreshDesk();
      await refresh().catch(() => {});
    } catch (err) { msg($('deskMsg'), 'err', err.message); }
  }
  $('deskDone').onclick = () => finishFromDesk('done');
  $('deskSkip').onclick = () => finishFromDesk('skip');
  // handheld-sized by default; the choice is kept in this browser
  const WIDE = 'desk:wide';
  const setWide = (w) => { $('deskWrap').classList.toggle('wide', w); $('deskWide').textContent = w ? 'Handheld size' : 'Full width'; try { localStorage.setItem(WIDE, w ? '1' : ''); } catch { /* private window */ } };
  try { setWide(localStorage.getItem(WIDE) === '1'); } catch { setWide(false); }
  $('deskWide').onclick = () => setWide(!$('deskWrap').classList.contains('wide'));
  document.addEventListener('subshow', (e) => { if (e.detail === 'desk') refreshDesk().catch(() => {}); });

  $('btnMvBuild').onclick = async () => {
    if (!needSession($('mvMsg'))) return;
    try {
      const r = await postJson(`${F}/moves/build`, { aisle: $('fMvAisle').value, zone: $('fMvZone').value, replace: $('fMvReplace').checked });
      msg($('mvMsg'), r.added ? 'ok' : 'warn', r.added ? `${r.added.toLocaleString()} pallets to move back.` : 'Nothing to move.',
        r.added ? 'They are on the scanners now — pick Front2Back at sign-on.' : r.found ? 'Every one found is already on the list.' : 'No front pallet on the report has an empty bin behind it (or the bin list does not say which bins are front and back).');
      await refresh();
    } catch (err) { msg($('mvMsg'), 'err', err.message); }
  };
  $('btnMvUpload').onclick = async () => {
    if (!needSession($('mvMsg'))) return;
    const file = $('fMvFile').files[0];
    if (!file) return msg($('mvMsg'), 'err', 'Choose a file first');
    try {
      const text = await fileToCsv(file);
      const res = await api.call(`${F}/moves/import?replace=${$('fMvReplace').checked ? 1 : 0}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      const r = await res.json();
      msg($('mvMsg'), 'ok', `${r.added.toLocaleString()} pallets to move back, from ${file.name}.`, r.found > r.added ? `${r.found - r.added} were already on the list.` : '');
      $('fMvFile').value = '';
      await refresh();
    } catch (err) { msg($('mvMsg'), 'err', 'That file did not load', err.message); }
  };
  $('btnMvCsv').onclick = () => { if (needSession($('mvMsg'))) api.download(`${F}/moves.csv`, 'pallets-to-move-back.csv'); };
  $('btnMvClear').onclick = async () => {
    if (!needSession($('mvMsg'))) return;
    if (!confirm('Take every pallet still waiting off the move list? Moves already done or skipped are kept.')) return;
    try {
      const r = await apiJson(`${F}/moves`, { method: 'DELETE' });
      msg($('mvMsg'), 'warn', `${r.cleared} taken off the list.`);
      await refresh();
    } catch (err) { msg($('mvMsg'), 'err', err.message); }
  };

  /* ------------------------------------------------- front-placed bins */
  const frQuery = () => new URLSearchParams({
    face: $('fFrFace').value, zone: $('fFrZone').value.trim(), aisle: $('fFrAisle').value.trim(), levels: $('fFrLevels').value.trim(),
  });
  const FACE = { front: 'Front', back: 'Back' };

  $('btnFrList').onclick = async () => {
    if (!needSession($('frMsg'))) return;
    try {
      const r = await apiJson(`${F}/bins?${frQuery()}`);
      const shown = r.bins.slice(0, 1000);
      msg($('frMsg'), r.count ? 'ok' : 'warn',
        `${r.count.toLocaleString()} ${r.face ? FACE[r.face].toLowerCase() + '-placed ' : ''}bin${r.count === 1 ? '' : 's'}`,
        r.count > shown.length ? `Showing the first ${shown.length.toLocaleString()} — download for the rest.` : (r.count ? '' : 'Nothing matches. Check the zone and aisles, or the face.'));
      table($('frTable'),
        [{ label: 'Bin' }, { label: 'Zone' }, { label: 'Aisle' }, { label: 'Level' }, { label: 'Face' }, { label: 'Last counted' }, { label: 'Cycle task' }],
        shown,
        (b) => {
          const tr = document.createElement('tr');
          tr.append(cell(b.code), cell(b.zone || '—'), cell(b.aisle || '—'), cell(b.level || '—'), cell(FACE[b.face] || '—'),
            cell(b.last_counted ? b.last_counted.slice(0, 10) : 'never'), cell(b.open_task ? 'open' : '—'));
          return tr;
        }, 'Nothing matches.');
    } catch (err) { msg($('frMsg'), 'err', err.message); }
  };
  $('btnFrCsv').onclick = async () => {
    if (!needSession($('frMsg'))) return;
    const q = frQuery(); q.set('format', 'csv');
    try { await api.download(`${F}/bins?${q}`, `${$('fFrFace').value || 'all'}-bins.csv`); }
    catch (err) { msg($('frMsg'), 'err', err.message); }
  };
  $('btnFrBatch').onclick = async () => {
    if (!needSession($('frMsg'))) return;
    try {
      const list = await apiJson(`${F}/bins?${frQuery()}`);
      const free = list.bins.filter((b) => !b.open_task).length;
      if (!free) return msg($('frMsg'), 'warn', 'Every bin in this list already has an open cycle task.');
      if (!confirm(`Put ${free.toLocaleString()} ${list.face ? FACE[list.face].toLowerCase() + '-placed ' : ''}bins on today's cycle count?`)) return;
      const r = await postJson(`${F}/cycle/batches`, {
        target: free, strategy: 'oldest', face: $('fFrFace').value, zone: $('fFrZone').value, aisle: $('fFrAisle').value,
        levels: $('fFrLevels').value, name: `${new Date().toISOString().slice(0, 10)} · ${list.face ? FACE[list.face].toLowerCase() + ' bins' : 'bins'}`,
      });
      msg($('frMsg'), 'ok', `Sent ${r.created.toLocaleString()} bins to the scanners.`, 'Teams see them at sign-on, or after a refresh.');
      await refresh();
    } catch (err) { msg($('frMsg'), 'err', err.message); }
  };


  document.addEventListener('subshow', () => { if (ready) refresh().catch(() => {}); });
  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    loadStatus().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && ready) refresh().catch(() => {}); }, 20000);
})();
