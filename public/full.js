/* Full Counts: every wall-to-wall on the site, in one place - which are open,
   how far each got, which one the scanners land on - with a new count started
   here and a set-up list for the one in the picker. The dashboard stays the
   live view of whichever count the picker holds. */
(() => {
  'use strict';

  const api = window.appApi;
  const { $, msg, clearMsg, table, cell, tag, button } = window.appUi;
  const apiJson = (p, o) => api.json(p, o);
  const postJson = (p, body, method) => api.post(p, body, method);

  let sessions = [];
  let sessionId = null;
  let defaultId = null;          // the count every scanner opens on at sign-on

  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }

  const picker = api.sessionPicker('sessionPick', (id) => {
    sessionId = Number(id) || null;
    picker.render(sessions, sessionId);
    renderAll().catch(() => {});
  });

  const pct = (s) => (s.bins ? Math.round((s.bins_counted / s.bins) * 1000) / 10 : 0);
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

  async function loadSessions() {
    sessions = (await apiJson('/api/admin/sessions')).filter((s) => (s.mode || 'full') === 'full' && !s.practice);
    try { defaultId = (await apiJson('/api/admin/default-session')).sessionId || null; } catch { defaultId = null; }
    if (!sessionId || !sessions.some((s) => s.id === sessionId)) {
      const open = sessions.find((s) => s.status !== 'closed') || sessions[0];
      sessionId = open ? open.id : null;
    }
    picker.render(sessions, sessionId);
  }

  function renderCounts() {
    const mayAdmin = api.can('admin');
    table($('fcTable'),
      [{ label: 'Count' }, { label: 'State' }, { label: 'Bins', num: true }, { label: 'Counted', num: true }, { label: 'Lines', num: true }, { label: 'Second counts open', num: true }, { label: 'Created' }, { label: 'Closed' }, { label: '' }],
      sessions,
      (s) => {
        const tr = document.createElement('tr');
        if (s.id === sessionId) tr.className = 'current';
        const name = cell(s.name);
        if (s.id === defaultId) name.append(' ', tag('ok', 'scanners land here'));
        const st = document.createElement('td');
        st.appendChild(tag(s.status === 'closed' ? 'off' : s.trial ? 'starter' : 'open', s.status === 'closed' ? 'closed' : s.trial ? 'trial run' : 'open'));
        if (s.show_on_guns === 0 && s.status !== 'closed') st.append(' · hidden from scanners');
        const acts = document.createElement('td');
        const row = document.createElement('div');
        row.className = 'fc-actions';
        row.appendChild(button('Open on the dashboard', 'sm primary', () => api.goto({ page: '/admin', sub: 'progress', session: s.id })));
        if (mayAdmin && s.status !== 'closed') {
          row.appendChild(button('Scanners land here', 'sm', async () => {
            try { await postJson('/api/admin/default-session', { sessionId: s.id }); msg($('fcMsg'), 'ok', `Scanners open on “${s.name}” at sign-on now.`); await renderAll(); }
            catch (err) { msg($('fcMsg'), 'err', err.message); }
          }));
        }
        if (mayAdmin) {
          row.appendChild(button(s.status === 'closed' ? 'Reopen' : 'Close', 'sm' + (s.status === 'closed' ? '' : ' danger'), async () => {
            if (s.status !== 'closed' && !confirm(`Close “${s.name}”? Scanners stop sending counts to it; its reports stay.`)) return;
            try { await postJson(`/api/admin/sessions/${s.id}/status`, { status: s.status === 'closed' ? 'open' : 'closed' }); msg($('fcMsg'), 'ok', s.status === 'closed' ? 'Reopened.' : 'Closed. The reports and exports stay.'); await renderAll(); }
            catch (err) { msg($('fcMsg'), 'err', err.message); }
          }));
        }
        acts.appendChild(row);
        tr.append(name, st, cell(s.bins.toLocaleString(), 'num'), cell(s.bins ? `${s.bins_counted.toLocaleString()} (${pct(s)}%)` : '—', 'num'),
          cell((s.lines || 0).toLocaleString(), 'num'), cell((s.recounts_open || 0).toLocaleString(), 'num'), cell(when(s.created_at)), cell(when(s.closed_at)), acts);
        return tr;
      },
      'No full count yet — start one under New count.');
  }

  async function renderSetup() {
    const box = $('setupList');
    box.innerHTML = '';
    const s = sessions.find((x) => x.id === sessionId);
    $('setupSub').textContent = s ? `for “${s.name}”` : '';
    if (!s) { box.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'Pick a count in the header, or start one.' })); return; }
    const st = await apiJson(`/api/admin/sessions/${s.id}/setup`);
    for (const step of st.steps || []) {
      const el = document.createElement('div');
      el.className = `setupstep ${step.need} ${step.done ? 'done' : ''}`;
      const dot = document.createElement('div'); dot.className = 'dot';
      const mid = document.createElement('div');
      mid.appendChild(Object.assign(document.createElement('div'), { className: 't', textContent: step.title }));
      mid.appendChild(Object.assign(document.createElement('div'), { className: 'd', textContent: step.done ? step.detail : `${step.why} ${step.detail ? '— ' + step.detail : ''}` }));
      const go = document.createElement('div');
      if (step.goto && step.goto.page && !step.done && api.canTab(step.goto.page, step.goto.sub)) {
        go.appendChild(button(step.label || 'Go', 'sm', () => api.goto({ ...step.goto, session: s.id })));
      } else if (step.done) go.appendChild(tag('done', 'done'));
      el.append(dot, mid, go);
      box.appendChild(el);
    }
    if ((st.steps || []).every((x) => x.done)) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'Everything the guided setup asks for is there. The count can be scanned.' }));
  }

  async function renderAll() {
    await loadSessions();
    renderCounts();
    await renderSetup();
  }

  $('btnCreate').onclick = async () => {
    try {
      const s = await postJson('/api/admin/sessions', { name: $('fNewName').value, mode: 'full' });
      $('fNewName').value = '';
      sessionId = s.id;
      msg($('newMsg'), 'ok', `Created “${s.name}”.`, 'Upload its bin list and inventory report under Settings → Lists & racking; the Set-up tab lists the rest.');
      await renderAll();
    } catch (err) { msg($('newMsg'), 'err', err.message); }
  };

  document.addEventListener('auth', (e) => {
    if (!e.detail) return show('login');
    show('main');
    if (!api.can('admin')) $('btnCreate').disabled = true;
    renderAll().catch(() => show('login'));
  });
  document.addEventListener('DOMContentLoaded', () => { api.start().catch(() => show('login')); });
  setInterval(() => { if (api.token && !document.hidden) renderAll().catch(() => {}); }, 20000);
})();
