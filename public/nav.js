/* Shared by the four supervisor pages: the tab bar, the sign-in box, and the
   little API helpers each page would otherwise repeat. */
(() => {
  'use strict';

  const TABS = [
    ['/admin', 'Dashboard'],
    ['/cycle', 'Cycle counts'],
    ['/teams', 'Teams & crew'],
    ['/settings', 'Settings'],
  ];

  const here = location.pathname.replace(/\/$/, '') || '/admin';
  const api = {
    token: sessionStorage.getItem('admToken') || '',
    me: null,

    async call(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { authorization: 'Bearer ' + api.token, ...(options.headers || {}) },
        cache: 'no-store',
      });
      if (res.status === 401) { api.logout(); throw new Error('Signed out — sign in again'); }
      if (!res.ok) {
        let msg = res.status + ' ' + res.statusText;
        try { msg = (await res.json()).error || msg; } catch { /* keep status text */ }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      return res;
    },
    json: (p, o) => api.call(p, o).then((r) => r.json()),
    post: (p, body, method = 'POST') =>
      api.json(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),

    async download(path, filename) {
      const res = await api.call(path);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    logout() {
      api.token = ''; api.me = null;
      sessionStorage.removeItem('admToken');
      document.dispatchEvent(new CustomEvent('auth', { detail: null }));
    },
  };
  window.appApi = api;

  /* ------------------------------------------------------- small UI helpers
     Every supervisor page draws the same kind of table and the same feedback
     line, so they live here rather than in each page's script. */
  const ui = {
    $: (id) => document.getElementById(id),
    msg(el, kind, text, detail) {
      if (typeof el === 'string') el = ui.$(el);
      if (!el) return;
      el.className = 'feedback show ' + kind;
      el.textContent = text;
      if (detail) {
        const d = document.createElement('div');
        d.className = 'detail';
        d.textContent = detail;
        el.appendChild(d);
      }
    },
    clearMsg(el) {
      if (typeof el === 'string') el = ui.$(el);
      if (el) { el.className = 'feedback'; el.textContent = ''; }
    },
    cell(text, cls) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text ?? '';
      return td;
    },
    tag(text) {
      const s = document.createElement('span');
      s.className = 'tag ' + text;
      s.textContent = text;
      return s;
    },
    button(label, cls, onclick) {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      if (onclick) b.onclick = onclick;
      return b;
    },
    table(el, columns, rows, renderRow, empty) {
      if (typeof el === 'string') el = ui.$(el);
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
      if (!rows.length) {
        const tr = document.createElement('tr');
        const td = ui.cell(empty || 'Nothing yet.');
        td.colSpan = columns.length;
        td.className = 'muted';
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      for (const r of rows) tbody.appendChild(renderRow(r));
      el.append(thead, tbody);
    },
    /* Excel files are converted to CSV in the browser (SheetJS, shipped with the
       app and loaded on first use), so an ERP export uploads as-is - no internet. */
    async fileToCsv(file) {
      if (!/\.xls[xm]?$/i.test(file.name)) return file.text();
      if (!window.XLSX) {
        await new Promise((res, rej) => {
          const sc = document.createElement('script');
          sc.src = '/vendor/xlsx.full.min.js';
          sc.onload = res;
          sc.onerror = () => rej(new Error('Could not load the Excel reader. Save the sheet as CSV instead.'));
          document.head.appendChild(sc);
        });
      }
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
    },
  };
  window.appUi = ui;

  function renderTabs() {
    const bar = document.getElementById('navTabs');
    if (!bar) return;
    bar.innerHTML = '';
    for (const [href, label] of TABS) {
      const a = document.createElement('a');
      a.href = href;
      a.className = 'tab' + (here === href ? ' current' : '');
      a.textContent = label;
      bar.appendChild(a);
    }
    const who = document.getElementById('navWho');
    if (who) {
      who.hidden = !api.me;
      // The shared password is always admin, so saying so adds nothing - flag it instead.
      const shared = !!api.me && !api.me.username;
      who.textContent = !api.me ? '' : shared ? api.me.name : `${api.me.name}${api.me.role === 'admin' ? ' · admin' : ''}`;
      who.title = !api.me ? '' : shared ? 'signed in with the shared password, not an account of your own' : `signed in as ${api.me.username}`;
      who.classList.toggle('shared', shared);
    }
    const out = document.getElementById('navLogout');
    if (out) out.hidden = !api.me;
  }

  async function signIn(usernameOrName, password) {
    // One field: it is a username if there is an account by that name, and
    // otherwise just who to record against the shared password. The server decides.
    const body = { username: usernameOrName, name: usernameOrName, password };
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = 'That did not work';
      try { msg = (await res.json()).error || msg; } catch { /* keep the default */ }
      throw new Error(msg);
    }
    const me = await res.json();
    api.token = me.token;
    api.me = me;
    sessionStorage.setItem('admToken', me.token);
    renderTabs();
    document.dispatchEvent(new CustomEvent('auth', { detail: me }));
    return me;
  }
  api.signIn = signIn;

  /** Every page calls this on load: are we signed in, and who are we? */
  api.start = async function start() {
    if (api.token) {
      try {
        api.me = await api.json('/api/admin/me');
      } catch { api.token = ''; api.me = null; sessionStorage.removeItem('admToken'); }
    }
    renderTabs();
    document.dispatchEvent(new CustomEvent('auth', { detail: api.me }));
    return api.me;
  };

  document.addEventListener('DOMContentLoaded', () => {
    renderTabs();
    const btn = document.getElementById('btnLogin');
    if (btn) {
      const go = async () => {
        const msg = document.getElementById('loginMsg');
        try {
          await signIn(document.getElementById('fUser').value.trim(), document.getElementById('fPassword').value);
          document.getElementById('fPassword').value = '';
          if (msg) { msg.className = 'feedback'; msg.textContent = ''; }
        } catch (err) {
          if (msg) { msg.className = 'feedback show err'; msg.textContent = err.message; }
        }
      };
      btn.onclick = go;
      for (const id of ['fUser', 'fPassword']) {
        document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      }
    }
    const out = document.getElementById('navLogout');
    if (out) out.onclick = () => api.logout();
  });
})();
