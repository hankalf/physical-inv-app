/* Practice data: every login's runs in the Testing Suite, in one place, for
   an admin. The Testing Suite itself shows a person their own practice and
   nobody else's; here the admin sees who has practiced, what each person
   tried and how far they got, can export one person's lot, or take it away
   so they start fresh. Practice counts are never in a dashboard's picker. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, table, cell, tag, button } = window.appUi;

  let data = { owners: [], people: 0, runs: 0, current: 0, lines: 0 };
  const open = new Set();              // the runs opened out to their things tried
  let who = '';

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }

  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const ago = (iso) => {
    if (!iso) return 'never';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 48 * 60) return `${Math.floor(mins / 60)} h ago`;
    return `${Math.floor(mins / 1440)} days ago`;
  };
  const label = (o) => (o.username ? `${o.name} · ${o.username}` : o.name);

  function tiles() {
    const box = $('pdTiles');
    box.innerHTML = '';
    for (const [n, l] of [
      [data.people, 'People who have practiced'],
      [data.runs, 'Runs'],
      [data.current, 'On a run now'],
      [Number(data.lines).toLocaleString(), 'Lines counted in practice'],
    ]) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.querySelector('.n').textContent = n;
      d.querySelector('.l').textContent = l;
      box.appendChild(d);
    }
  }

  function whoList() {
    const sel = $('fPdWho');
    const was = sel.value;
    sel.innerHTML = '<option value="">Everyone</option>';
    for (const o of data.owners) {
      const opt = document.createElement('option');
      opt.value = o.owner;
      opt.textContent = label(o);
      sel.appendChild(opt);
    }
    sel.value = data.owners.some((o) => o.owner === was) ? was : '';
    who = sel.value;
  }

  function render() {
    tiles();
    whoList();
    const currentOnly = $('fPdCurrent').checked;
    const rows = [];
    for (const o of data.owners) {
      if (who && o.owner !== who) continue;
      const runs = o.runs.filter((r) => !currentOnly || r.status === 'current');
      runs.forEach((r, i) => rows.push({ o, r, first: i === 0, n: runs.length }));
    }
    table($('pdTable'),
      [{ label: 'Who' }, { label: 'Run' }, { label: 'Started' }, { label: 'Last activity' }, { label: 'Test data' },
        { label: 'Things tried' }, { label: 'Bins', num: true }, { label: 'Lines', num: true }, { label: '' }],
      rows,
      ({ o, r, first }) => {
        const frag = document.createDocumentFragment();
        const tr = document.createElement('tr');
        tr.dataset.run = r.id;
        tr.dataset.owner = o.owner;
        const w = cell('', 'who');
        if (first) {
          w.append(document.createTextNode(o.name));
          const s = document.createElement('small');
          s.textContent = [o.username, o.role === 'admin' ? 'admin' : '', o.active === false ? 'login off' : ''].filter(Boolean).join(' · ');
          w.appendChild(s);
        }
        const run = cell('');
        run.append(document.createTextNode(`#${r.id} `), tag(r.status === 'current' ? 'ok' : 'off', r.status));
        const tried = cell('');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkish';
        b.textContent = `${r.tried} of ${r.of}${open.has(r.id) ? ' ▴' : ' ▾'}`;
        b.title = open.has(r.id) ? 'Close' : 'What was tried on this run';
        b.onclick = () => { if (open.has(r.id)) open.delete(r.id); else open.add(r.id); render(); };
        tried.appendChild(b);
        const acts = cell('');
        const box = document.createElement('div');
        box.className = 'acts';
        if (first) {
          box.append(
            button('Export', 'sm', () => exportOf(o)),
            button('Delete', 'sm danger', () => deleteOf(o)));
        }
        acts.appendChild(box);
        tr.append(w, run, cell(when(r.started)), cell(r.lastActivity ? ago(r.lastActivity) : '—'), cell(r.source),
          tried, cell(`${r.bins} / ${r.binsTotal}`, 'num'), cell(r.lines, 'num'), acts);
        frag.appendChild(tr);
        if (open.has(r.id)) {
          const more = document.createElement('tr');
          more.className = 'more';
          const td = document.createElement('td');
          td.colSpan = 9;
          const list = document.createElement('div');
          list.className = 'tried';
          for (const c of r.checklist) {
            const d = document.createElement('div');
            d.className = c.done ? 'done' : '';
            d.append(Object.assign(document.createElement('i'), { textContent: c.done ? '✓' : '○' }), document.createTextNode(c.label));
            list.appendChild(d);
          }
          const jobs = document.createElement('div');
          jobs.className = 'jobs';
          jobs.append(document.createTextNode(r.jobs.length ? 'Also set up on this run: ' : 'Only the full count on this run'));
          for (const j of r.jobs) jobs.appendChild(tag('', j));
          list.appendChild(jobs);
          td.appendChild(list);
          more.appendChild(td);
          frag.appendChild(more);
        }
        return frag;
      }, who || currentOnly ? 'No run to show for that.' : 'Nobody has opened the Testing Suite yet.');
  }

  async function refresh() {
    data = await api.json('/api/admin/practice/all');
    render();
  }

  /* one workbook of everything this person did: the same export the Testing Suite gives them */
  async function exportOf(o) {
    clearMsg($('pdMsg'));
    try {
      const [out, XLSX] = await Promise.all([api.json(`/api/admin/practice/all/export?owner=${encodeURIComponent(o.owner)}`), window.appUi.loadXlsx()]);
      const wb = XLSX.utils.book_new();
      for (const sh of out.sheets) {
        const ws = XLSX.utils.json_to_sheet(sh.rows, { header: sh.columns });
        ws['!cols'] = sh.columns.map((c) => ({
          wch: Math.min(60, Math.max(String(c).length, ...sh.rows.slice(0, 500).map((r) => String(r[c] ?? '').length)) + 2),
        }));
        if (sh.rows.length && !/Summary$/.test(sh.name)) ws['!autofilter'] = { ref: ws['!ref'] };
        XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
      }
      XLSX.writeFile(wb, out.filename);
      msg($('pdMsg'), 'ok', `Exported ${out.runs} run${out.runs === 1 ? '' : 's'} of ${o.name}'s.`, out.filename);
    } catch (err) { msg($('pdMsg'), 'err', 'Could not build the export', err.message); }
  }

  async function deleteOf(o) {
    clearMsg($('pdMsg'));
    if (!confirm(`Delete ${o.name}'s practice?\n\nEvery run (${o.runs.length}) goes, and the Testing Suite starts them fresh next time. Real counts are not touched.`)) return;
    try {
      const out = await api.post(`/api/admin/practice/all?owner=${encodeURIComponent(o.owner)}`, {}, 'DELETE');
      msg($('pdMsg'), 'ok', `${o.name}'s practice is gone.`, `${out.runs} run${out.runs === 1 ? '' : 's'} deleted.`);
      await refresh();
    } catch (err) { msg($('pdMsg'), 'err', 'Not deleted', err.message); }
  }

  $('fPdWho').onchange = () => { who = $('fPdWho').value; render(); };
  $('fPdCurrent').onchange = () => render();
  $('btnPdRefresh').onclick = () => refresh().catch((err) => msg($('pdMsg'), 'err', err.message));

  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    refresh().catch((err) => msg($('pdMsg'), 'err', err.message));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && !document.hidden) refresh().catch(() => {}); }, 30000);
})();
