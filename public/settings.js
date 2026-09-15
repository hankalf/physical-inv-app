/* Settings: supervisor logins, scanner setup, list uploads, racking blocks,
   the ERP export, and backups + the audit log. Everything a supervisor sets up
   once and then leaves alone lives here, off the working dashboard. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, cell, tag, table, button, fileToCsv } = window.appUi;

  let sessionId = null;
  let sessions = [];
  let me = null;

  const needSession = (el) => {
    if (sessionId) return true;
    msg(el, 'err', 'There is no count session yet', 'Create one on the Dashboard, then come back here to set it up.');
    return false;
  };

  const titleCase = (z) => String(z || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const aisleLabel = (aisle, zone) => (zone ? `${titleCase(zone)} – Aisle ${aisle}` : `Aisle ${aisle}`);

  /* ------------------------------------------------------------ accounts */
  async function refreshMe() {
    me = await api.json('/api/admin/me');
    const isAdmin = me.role === 'admin';
    $('adminOnly').hidden = !isAdmin;
    $('notAdmin').hidden = isAdmin;
    $('ownPassword').hidden = !me.username;
    $('ownPasswordNA').hidden = !!me.username;
    const chip = $('sharedChip');
    // Once there is a real login, the shared password is the thing to turn off.
    if (me.sharedLogin) {
      chip.hidden = false;
      chip.className = 'chip ' + (me.accounts ? 'offline' : '');
      chip.textContent = me.accounts ? 'shared password still accepted' : 'shared password only';
      chip.title = 'Set SHARED_PASSWORD_LOGIN=off once everyone has their own login.';
    } else {
      chip.hidden = false;
      chip.className = 'chip online';
      chip.textContent = 'logins only';
      chip.title = 'The shared password is turned off — every supervisor signs in as themselves.';
    }
    if (isAdmin) await refreshUsers();
  }

  async function refreshUsers() {
    const { users } = await api.json('/api/admin/users');
    table($('userTable'),
      [{ label: 'Username' }, { label: 'Name' }, { label: 'Role' }, { label: 'Status' }, { label: 'Last signed in' }, { label: 'Added' }, { label: '' }],
      users,
      (u) => {
        const tr = document.createElement('tr');
        tr.append(cell(u.username), cell(u.name, 'wrap'));
        const tdRole = document.createElement('td');
        tdRole.appendChild(tag(u.role));
        tr.appendChild(tdRole);
        const tdSt = document.createElement('td');
        tdSt.appendChild(u.active ? tag('active') : tag('off'));
        if (u.active && u.mustChange) {
          const w = tag('starter');
          w.title = 'Still on the password they were given — they choose their own at their next sign-in.';
          w.style.marginLeft = '4px';
          tdSt.appendChild(w);
        }
        tr.appendChild(tdSt);
        tr.append(
          cell(u.last_login ? new Date(u.last_login).toLocaleString() : 'never'),
          cell(u.created_at ? new Date(u.created_at).toLocaleDateString() : ''),
        );

        const act = document.createElement('td');
        const change = async (body, confirmText) => {
          if (confirmText && !confirm(confirmText)) return;
          try { await api.post(`/api/admin/users/${u.username}`, body); clearMsg($('userMsg')); await refreshUsers(); }
          catch (err) { msg($('userMsg'), 'err', err.message); }
        };
        act.appendChild(button(u.role === 'admin' ? 'Make supervisor' : 'Make admin', 'sm', () =>
          change({ role: u.role === 'admin' ? 'supervisor' : 'admin' })));
        act.appendChild(button(u.active ? 'Deactivate' : 'Reactivate', 'sm', () =>
          change({ active: !u.active }, u.active ? `Deactivate ${u.username}? They will not be able to sign in.` : '')));
        act.appendChild(button('Reset password', 'sm', async () => {
          const pw = prompt(`New password for ${u.username} — leave blank to generate one.\n\nEither way they choose their own the next time they sign in.`, '');
          if (pw === null) return;
          try {
            const r = await api.post(`/api/admin/users/${u.username}`, { password: pw });
            if (r.starterPassword) { clearMsg($('userMsg')); showStarter(u.username, r.starterPassword); }
            else msg($('userMsg'), 'ok', `${u.username} has a new password`, 'They will be asked to replace it when they next sign in.');
            await refreshUsers();
          } catch (err) { msg($('userMsg'), 'err', err.message); }
        }));
        act.appendChild(button('Remove', 'sm danger', async () => {
          if (!confirm(`Remove ${u.username}? Their entries in the log are kept.`)) return;
          try { await api.call(`/api/admin/users/${u.username}`, { method: 'DELETE' }); clearMsg($('userMsg')); await refreshUsers(); }
          catch (err) { msg($('userMsg'), 'err', err.message); }
        }));
        for (const b of act.querySelectorAll('button')) b.style.marginRight = '4px';
        tr.appendChild(act);
        return tr;
      }, 'No logins yet — everyone is signing in with the shared password.');
  }

  /* A starter password is shown once, big enough to read across a desk, and is
     not recoverable afterwards - it exists only to get its owner to the screen
     where they choose their own. */
  function showStarter(username, password) {
    const box = $('starterBox');
    box.style.display = 'block';
    box.className = 'feedback show ok';
    box.textContent = '';
    const head = document.createElement('div');
    head.textContent = `${username} can sign in now — read them this password:`;
    const code = document.createElement('div');
    code.textContent = password;
    code.style.cssText = 'font-size:26px;font-weight:800;letter-spacing:.06em;margin:8px 0;user-select:all';
    const why = document.createElement('div');
    why.className = 'detail';
    why.textContent = 'They will be asked to choose their own password the moment they sign in. This one is not shown again — if it is lost, use Reset password.';
    box.append(head, code, why);
  }

  $('btnAddUser').onclick = async () => {
    try {
      const u = await api.post('/api/admin/users', {
        username: $('fNewUser').value, name: $('fNewFullName').value,
        password: $('fNewPass').value, role: $('fNewRole').value,
      });
      $('fNewUser').value = ''; $('fNewFullName').value = ''; $('fNewPass').value = '';
      if (u.starterPassword) { clearMsg($('userMsg')); showStarter(u.username, u.starterPassword); }
      else msg($('userMsg'), 'ok', `Added ${u.username}`, 'They will be asked to choose their own password the first time they sign in.');
      await refreshMe();
    } catch (err) { msg($('userMsg'), 'err', err.message); }
  };
  $('fNewPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddUser').click(); });

  $('btnChangePass').onclick = async () => {
    try {
      await api.post('/api/admin/me/password', { current: $('fCurPass').value, next: $('fNextPass').value });
      $('fCurPass').value = ''; $('fNextPass').value = '';
      msg($('passMsg'), 'ok', 'Password changed.');
    } catch (err) { msg($('passMsg'), 'err', err.message); }
  };

  /* ------------------------------------------------------------ scanners */
  const deviceUrl = (uid) => `${location.origin}/?d=${uid}`;

  async function refreshDevices() {
    const data = await api.json('/api/admin/devices');
    $('authChip').hidden = false;
    $('authChip').textContent = data.authRequired ? 'scanners must sign in' : 'scanner sign-in OFF';
    $('authChip').className = 'chip ' + (data.authRequired ? 'online' : 'offline');
    table($('deviceTable'),
      [{ label: 'Scanner' }, { label: 'Link' }, { label: '' }, { label: 'Signed in' }, { label: 'Last seen' }, { label: 'Team' }, { label: 'Notes' }, { label: '' }],
      data.devices,
      (d) => {
        const tr = document.createElement('tr');
        tr.append(cell(d.name));
        const tdLink = document.createElement('td');
        const code = document.createElement('code'); code.className = 'link'; code.textContent = deviceUrl(d.uid);
        tdLink.appendChild(code); tr.appendChild(tdLink);
        const tdBtns = document.createElement('td');
        const copy = button('Copy', 'sm', async () => {
          try { await navigator.clipboard.writeText(deviceUrl(d.uid)); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); }
          catch { prompt('Copy this link', deviceUrl(d.uid)); }
        });
        const qr = button('QR', 'sm', () => showQr(d));
        qr.style.marginLeft = '4px';
        tdBtns.append(copy, qr); tr.appendChild(tdBtns);
        const tdEnrol = document.createElement('td');
        if (d.enrolled_at) {
          tdEnrol.append(new Date(d.enrolled_at).toLocaleDateString());
          if (d.enrol_count > 1) {
            const w = document.createElement('span');
            w.className = 'tag'; w.style.marginLeft = '6px'; w.style.color = 'var(--warn)'; w.style.borderColor = '#5c4813';
            w.textContent = `${d.enrol_count}×`;
            w.title = `This link has been used ${d.enrol_count} times. Normal after a scanner is wiped — otherwise reset it.`;
            tdEnrol.appendChild(w);
          }
        } else { const n = document.createElement('span'); n.className = 'muted'; n.textContent = 'not yet'; tdEnrol.appendChild(n); }
        tr.appendChild(tdEnrol);
        tr.append(cell(d.last_seen ? new Date(d.last_seen).toLocaleString() : 'never'), cell(d.last_team || '—'), cell(d.notes || '', 'wrap'));

        const tdDel = document.createElement('td');
        const reset = button('Reset link', 'sm', async () => {
          if (!confirm(`Reset ${d.name}? Its current link stops working immediately and the scanner must open the new one.`)) return;
          try {
            await api.post(`/api/admin/devices/${d.uid}/reset`, {});
            await refreshDevices();
            msg($('deviceMsg'), 'ok', `${d.name} has a new link`, 'Open it on the scanner, then add it to the home screen again.');
          } catch (err) { msg($('deviceMsg'), 'err', err.message); }
        });
        reset.style.marginRight = '4px';
        reset.title = 'Issue a new link and stop the old one working — use if a link leaks or a scanner is lost';
        tdDel.appendChild(reset);
        tdDel.appendChild(button('Remove', 'sm danger', async () => {
          if (!confirm(`Remove ${d.name}? Its link will stop working on the device.`)) return;
          try { await api.call(`/api/admin/devices/${d.uid}`, { method: 'DELETE' }); await refreshDevices(); }
          catch (err) { msg($('deviceMsg'), 'err', err.message); }
        }));
        tr.appendChild(tdDel);
        return tr;
      }, 'No scanners registered yet.');
  }

  async function showQr(d) {
    $('qrTitle').textContent = d.name;
    $('qrUrl').textContent = deviceUrl(d.uid);
    $('qrBox').innerHTML = '';
    $('qrModal').hidden = false;
    try {
      if (!window.QRCode) {
        await new Promise((res, rej) => {
          const sc = document.createElement('script');
          sc.src = '/vendor/qrcode.min.js';
          sc.onload = res; sc.onerror = () => rej(new Error('QR library missing - copy the link instead'));
          document.head.appendChild(sc);
        });
      }
      new window.QRCode($('qrBox'), { text: deviceUrl(d.uid), width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
    } catch (err) { $('qrBox').textContent = 'QR unavailable: ' + err.message; }
  }
  $('btnQrClose').onclick = () => { $('qrModal').hidden = true; };
  $('qrModal').onclick = (e) => { if (e.target === $('qrModal')) $('qrModal').hidden = true; };

  $('btnAddDevice').onclick = async () => {
    try {
      const d = await api.post('/api/admin/devices', { name: $('fDevName').value, notes: $('fDevNotes').value });
      $('fDevName').value = ''; $('fDevNotes').value = '';
      msg($('deviceMsg'), 'ok', `Added ${d.name}`, `Its link is ${deviceUrl(d.uid)} — open it on the device and add to the home screen.`);
      await refreshDevices();
    } catch (err) { msg($('deviceMsg'), 'err', err.message); }
  };
  $('fDevName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddDevice').click(); });

  // A printed sheet of QR codes, so a scanner is set up by scanning, not typing
  // a URL on a keypad. It is a page, not a download, so the token rides the URL.
  $('btnCards').onclick = () => window.open(`/api/admin/print/scanner-cards?t=${encodeURIComponent(api.token)}`, '_blank');

  /* ------------------------------------------------------------ uploads */
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
      required: [['Team', 'team number'], ['Aisle', 'the full aisle code from the bin list, e.g. F01 - a bare number is refused when it could mean two aisles (A01 / F01)'],
                 ['Levels', 'which levels the team counts, by equipment: A-C, D-F, or A-F for every level']],
      optional: [],
      note: 'One row per aisle, in the order each team should count. Upload the bin list first. Aisles can also be queued by hand under Team assignments on the Dashboard.',
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

  async function uploadText(kind, text, label) {
    if (!needSession($('uploadMsg'))) return;
    msg($('uploadMsg'), 'warn', `Uploading ${label}…`);
    try {
      const stats = await api.json(`/api/admin/sessions/${sessionId}/master?kind=${kind}&replace=${$('fReplace').checked ? 1 : 0}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      const t = stats.totals;
      msg($('uploadMsg'), 'ok', `Imported ${stats.rows.toLocaleString()} rows from ${label}`,
        `Session now has ${t.bins.toLocaleString()} bins in ${t.aisles} aisles, ${t.pallets.toLocaleString()} pallets, ${t.assignments} planned aisle assignments` +
        (stats.skipped ? ` · ${stats.skipped} row(s) skipped (${stats.skippedNoLevels ? stats.skippedNoLevels + ' with no levels; ' : ''}missing required column, or unknown aisle)` : '') +
        (stats.excluded ? ` · ${stats.excluded} bins left out (counted manually: ${stats.excludedGroups.join(', ')})` : ''));
      await refreshAisles();
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  }

  $('btnUpload').onclick = async () => {
    const file = $('fFile').files[0];
    if (!file) return msg($('uploadMsg'), 'err', 'Choose a file first');
    if (!needSession($('uploadMsg'))) return;
    msg($('uploadMsg'), 'warn', `Reading ${file.name}…`);
    try {
      await uploadText($('fKind').value, await fileToCsv(file), file.name);
      $('fFile').value = '';
    } catch (err) { msg($('uploadMsg'), 'err', 'Upload failed', err.message); }
  };

  $('btnLoadSiteBins').onclick = async () => {
    if (!needSession($('uploadMsg'))) return;
    const res = await fetch('/templates/front-royal-bins.csv');
    await uploadText('bins', await res.text(), 'the Front Royal bin list');
  };

  /* ------------------------------------------------------------ aisles & blocks */
  function renderAisles(aisles) {
    table($('aisleTable'),
      [{ label: 'Aisle' }, { label: 'Block' }, { label: 'Bins', num: true }, { label: 'Counted', num: true }, { label: 'Progress' }, { label: 'Status' }],
      aisles,
      (a) => {
        const tr = document.createElement('tr');
        tr.append(cell(aisleLabel(a.aisle, a.zone)));
        const tdBlock = document.createElement('td');
        const inp = document.createElement('input');
        inp.className = 'sm';
        inp.value = a.block;
        inp.title = 'Type a block name and press Enter';
        inp.onkeydown = async (e) => {
          if (e.key !== 'Enter') return;
          try { renderAisles(await api.post(`/api/admin/sessions/${sessionId}/aisles/block`, { aisle: a.aisle, block: inp.value })); clearMsg($('aisleMsg')); }
          catch (err) { msg($('aisleMsg'), 'err', err.message); }
        };
        tdBlock.appendChild(inp);
        tr.append(tdBlock, cell(a.bins, 'num'), cell(a.bins_counted, 'num'));
        const td = document.createElement('td');
        const bar = document.createElement('div'); bar.className = 'bar';
        const i = document.createElement('i'); i.style.width = (a.bins ? Math.round((a.bins_counted / a.bins) * 100) : 0) + '%';
        bar.appendChild(i); td.appendChild(bar); tr.appendChild(td);
        const st = document.createElement('td');
        if (a.active_team) st.appendChild(tag('active')), st.append(` team ${a.active_detail}`);
        else if (a.done_count) st.appendChild(tag('done'));
        else if (a.queued_teams) st.appendChild(tag('queued')), st.append(` team ${a.queued_teams}`);
        else st.append('—');
        tr.appendChild(st);
        return tr;
      }, 'Upload a bin list to see aisles.');
  }

  async function refreshAisles() {
    if (!sessionId) return renderAisles([]);
    renderAisles(await api.json(`/api/admin/sessions/${sessionId}/aisles`));
  }

  $('btnAutoBlock').onclick = async () => {
    if (!needSession($('aisleMsg'))) return;
    try {
      renderAisles(await api.post(`/api/admin/sessions/${sessionId}/aisles/auto-block`,
        { size: Number($('fBlockSize').value), offset: Number($('fBlockOffset').value) }));
      msg($('aisleMsg'), 'ok', 'Aisles paired into blocks.');
    } catch (err) { msg($('aisleMsg'), 'err', err.message); }
  };
  $('btnLayoutBlocks').onclick = async () => {
    if (!needSession($('aisleMsg'))) return;
    try {
      const r = await api.post(`/api/admin/sessions/${sessionId}/aisles/apply-layout`, {});
      renderAisles(r.aisles);
      msg($('aisleMsg'), 'ok', `Paired ${r.applied} aisle(s) the way the drawing shows them.` + (r.pruned ? ` Removed ${r.pruned} non-aisle group(s) from the list.` : ''));
    } catch (err) { msg($('aisleMsg'), 'err', err.message); }
  };

  /* ------------------------------------------------------------ ERP */
  async function refreshErp() {
    const data = await api.json('/api/admin/erp/formats');
    const sel = $('fErpFormat');
    const prior = sel.value;
    sel.innerHTML = '';
    for (const [id, f] of Object.entries(data.formats)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = f.label || id;
      sel.appendChild(o);
    }
    if (prior && data.formats[prior]) sel.value = prior;
  }
  $('btnErpPreview').onclick = async () => {
    if (!needSession($('erpMsg'))) return;
    try {
      const r = await api.json(`/api/admin/sessions/${sessionId}/erp/${$('fErpFormat').value}/preview`);
      msg($('erpMsg'), 'ok', `${r.rows.toLocaleString()} rows — ${r.format.label}`, 'First few lines below. Nothing has been sent anywhere.');
      $('erpSample').style.display = 'block';
      $('erpSample').textContent = r.sample;
    } catch (err) { msg($('erpMsg'), 'err', err.message); }
  };
  $('btnErpDownload').onclick = () => {
    if (!needSession($('erpMsg'))) return;
    api.download(`/api/admin/sessions/${sessionId}/erp/${$('fErpFormat').value}.csv`, `${$('fErpFormat').value}-${sessionId}.csv`)
      .catch((err) => msg($('erpMsg'), 'err', err.message));
  };

  /* ------------------------------------------------------------ backups & log */
  async function refreshOps() {
    const [b, log] = await Promise.all([api.json('/api/admin/backups'), api.json('/api/admin/audit?limit=60')]);
    $('backupSub').textContent = b.backups.length
      ? `${b.backups.length} kept (newest ${new Date(b.backups[0].at).toLocaleString()}), one a day, ${b.keep} retained`
      : 'no backups yet';
    table($('backupTable'), [{ label: 'Backup' }, { label: 'Size', num: true }, { label: 'Taken' }, { label: '' }], b.backups.slice(0, 20),
      (f) => {
        const tr = document.createElement('tr');
        tr.append(cell(f.name), cell(Math.round(f.bytes / 1024).toLocaleString() + ' KB', 'num'), cell(new Date(f.at).toLocaleString()));
        const td = document.createElement('td');
        td.appendChild(button('Download', 'sm', () => api.download(`/api/admin/backups/${f.name}`, f.name)));
        tr.appendChild(td);
        return tr;
      }, 'No backups yet — one is taken automatically each day.');
    table($('auditTable'), [{ label: 'When' }, { label: 'Who' }, { label: 'Did what' }, { label: 'Detail' }], log,
      (a) => {
        const tr = document.createElement('tr');
        tr.append(cell(new Date(a.at).toLocaleString()), cell(a.actor), cell(a.action), cell(a.detail || '', 'wrap'));
        return tr;
      }, 'Nothing recorded yet.');
  }
  $('btnBackupNow').onclick = async () => {
    try {
      const b = await api.post('/api/admin/backups', {});
      msg($('opsMsg'), 'ok', `Backed up — ${b.name}`, `${Math.round(b.bytes / 1024).toLocaleString()} KB. Download it if you want a copy off this machine.`);
      await refreshOps();
    } catch (err) { msg($('opsMsg'), 'err', err.message); }
  };
  $('btnAuditExport').onclick = () => api.download('/api/admin/audit/export.csv', 'audit-log.csv')
    .catch((err) => msg($('opsMsg'), 'err', err.message));

  /* ------------------------------------------------------------ session scope */
  async function loadSessions() {
    sessions = await api.json('/api/admin/sessions');
    const sel = $('fSessionPick');
    const prior = sessionId;
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `#${s.id} — ${s.name} (${s.mode === 'cycle' ? 'cycle · ' : ''}${s.status})`;
      sel.appendChild(o);
    }
    if (!sessions.length) {
      sel.innerHTML = '<option value="">No sessions yet — create one on the Dashboard</option>';
      sessionId = null;
    } else {
      sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
      sel.value = String(sessionId);
    }
    applyScope();
    await refreshAisles();
  }

  function applyScope() {
    const s = sessions.find((x) => x.id === sessionId);
    // a cycle count has no aisle plan, so its racking blocks are not used
    $('btnLayoutBlocks').closest('.card').hidden = !!s && s.mode === 'cycle';
    $('btnLayoutBlocks').hidden = !(s && s.layout);   // only when a drawing is chosen for the session
    $('scopeNote').textContent = !s
      ? 'Uploads, racking blocks and the ERP export all need a session.'
      : s.mode === 'cycle'
        ? 'A cycle count — bins go out in batches, so there is no aisle plan to block out.'
        : 'Uploads, racking blocks and the ERP export below act on this session.';
  }

  // the session bar only means anything to the panes that act on a session
  document.addEventListener('subshow', (e) => {
    $('scopeBar').hidden = !['lists', 'erp'].includes(e.detail);
  });

  $('fSessionPick').onchange = (e) => {
    sessionId = Number(e.target.value) || null;
    applyScope();
    refreshAisles().catch(() => {});
  };

  /* ------------------------------------------------------------ boot */
  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }

  async function load() {
    await refreshMe();
    await Promise.all([refreshDevices(), refreshErp(), refreshOps()]);
    await loadSessions();
  }

  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    load().catch((err) => msg($('userMsg'), 'err', err.message));
  });

  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => {
    if (api.token && $('scrMain').classList.contains('active')) refreshDevices().catch(() => {});
  }, 30000);
})();
