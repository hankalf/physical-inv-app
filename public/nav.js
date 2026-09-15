/* Shared by the four supervisor pages: the tab bar, the sign-in box, and the
   little API helpers each page would otherwise repeat. */
(() => {
  'use strict';

  const TABS = [
    ['/admin', 'Dashboard', '▤'],
    ['/cycle', 'Cycle counts', '↻'],
    ['/teams', 'Teams & crew', '☰'],
    ['/settings', 'Settings', '⚙'],
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
      const box = document.getElementById('navSetPassword');
      if (box) { box.hidden = true; box.classList.remove('active'); }
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
    for (const [href, label, ico] of TABS) {
      const a = document.createElement('a');
      a.href = href;
      a.className = 'tab' + (here === href ? ' current' : '');
      const i = document.createElement('span');
      i.className = 'ico';
      i.textContent = ico;
      a.append(i, document.createTextNode(label));
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
    if (me.mustChange) justTyped = password;      // so the next step need not ask again
    renderTabs();
    announce();
    return me;
  }
  api.signIn = signIn;

  /* ---------------------------------------------------------- first sign-in
     A login handed out with a starter password gets no further than choosing a
     real one. The panel is built here so every page has it without markup. */
  let justTyped = '';

  function announce() {
    if (api.me && api.me.mustChange) return setPassword();
    const box = setPasswordPanel();
    box.hidden = true;
    box.classList.remove('active');     // so the DOM does not claim a screen that is not showing
    document.dispatchEvent(new CustomEvent('auth', { detail: api.me }));
  }

  function setPasswordPanel() {
    let box = document.getElementById('navSetPassword');
    if (box) return box;
    box = document.createElement('section');
    box.id = 'navSetPassword';
    box.className = 'screen active';
    box.innerHTML = `
      <div class="card signin">
        <h2>Choose your password</h2>
        <div class="hint" id="npWho"></div>
        <div id="npCurrentWrap" hidden>
          <label for="npCurrent">The password you were given</label>
          <input id="npCurrent" type="password" autocomplete="current-password">
        </div>
        <label for="npNext">New password <span style="text-transform:none;letter-spacing:0">— at least 8 characters</span></label>
        <input id="npNext" type="password" autocomplete="new-password">
        <label for="npConfirm">Type it again</label>
        <input id="npConfirm" type="password" autocomplete="new-password">
        <button class="primary" id="npSave" style="width:100%;margin-top:10px">Save and carry on</button>
        <div class="feedback" id="npMsg"></div>
      </div>`;
    (document.querySelector('main') || document.body).appendChild(box);
    const save = async () => {
      const m = box.querySelector('#npMsg');
      const next = box.querySelector('#npNext').value;
      const current = justTyped || box.querySelector('#npCurrent').value;
      const fail = (t) => { m.className = 'feedback show err'; m.textContent = t; };
      if (next.length < 8) return fail('At least 8 characters, please');
      if (next !== box.querySelector('#npConfirm').value) return fail('Those two do not match');
      try {
        await api.post('/api/admin/me/password', { current, next });
        justTyped = '';
        api.me = { ...api.me, mustChange: false };
        for (const id of ['npCurrent', 'npNext', 'npConfirm']) box.querySelector('#' + id).value = '';
        m.className = 'feedback';
        m.textContent = '';
        announce();
      } catch (err) { fail(err.message); }
    };
    box.querySelector('#npSave').onclick = save;
    for (const id of ['npCurrent', 'npNext', 'npConfirm']) {
      box.querySelector('#' + id).addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }
    return box;
  }

  function setPassword() {
    // hide whatever the page is showing; this is the only thing on screen now
    for (const el of document.querySelectorAll('main > .screen')) el.classList.remove('active');
    const box = setPasswordPanel();
    box.hidden = false;
    box.classList.add('active');
    box.querySelector('#npCurrentWrap').hidden = !!justTyped;
    box.querySelector('#npWho').textContent = justTyped
      ? `Signed in as ${api.me.username}. This login was handed to you with a starter password — pick one only you know, then you are through.`
      : `Signed in as ${api.me.username}. Finish setting up this login: type the password you were given, then one only you know.`;
    box.querySelector(justTyped ? '#npNext' : '#npCurrent').focus();
  }

  /** Every page calls this on load: are we signed in, and who are we? */
  api.start = async function start() {
    if (api.token) {
      try {
        api.me = await api.json('/api/admin/me');
      } catch { api.token = ''; api.me = null; sessionStorage.removeItem('admToken'); }
    }
    renderTabs();
    announce();
    return api.me;
  };

  /* ------------------------------------------------------------- sub-tabs
     A page declares them by marking its sections <section data-sub="map"
     data-sub-label="Map">. One screen, one job - nobody scrolls past four
     cards to reach the one they came for. */
  const subKey = 'sub:' + here;

  function renderSubTabs() {
    const bar = document.getElementById('subTabs');
    const panes = [...document.querySelectorAll('[data-sub]')];
    if (!bar || !panes.length) return;
    const wanted = (location.hash || '').replace('#', '') || sessionStorage.getItem(subKey) || panes[0].dataset.sub;
    bar.innerHTML = '';
    for (const pane of panes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.goto = pane.dataset.sub;
      b.textContent = pane.dataset.subLabel || pane.dataset.sub;
      const n = document.createElement('span');
      n.className = 'n';
      n.id = 'subCount-' + pane.dataset.sub;
      n.hidden = true;
      b.appendChild(n);
      b.onclick = () => api.showSub(pane.dataset.sub);
      bar.appendChild(b);
    }
    api.showSub(panes.some((p) => p.dataset.sub === wanted) ? wanted : panes[0].dataset.sub);
  }

  /** Switch sub-tab. Pages listen for `subshow` to refresh what just appeared. */
  api.showSub = function showSub(name) {
    for (const pane of document.querySelectorAll('[data-sub]')) pane.classList.toggle('active', pane.dataset.sub === name);
    for (const b of document.querySelectorAll('#subTabs button')) b.classList.toggle('current', b.dataset.goto === name);
    try { sessionStorage.setItem(subKey, name); } catch { /* private window */ }
    if (location.hash.replace('#', '') !== name) history.replaceState(null, '', '#' + name);
    document.dispatchEvent(new CustomEvent('subshow', { detail: name }));
  };

  /** A count beside a sub-tab: how many second counts are open, and so on. */
  api.subCount = function subCount(name, n) {
    const el = document.getElementById('subCount-' + name);
    if (!el) return;
    el.hidden = !n;
    el.textContent = n;
  };

  document.addEventListener('DOMContentLoaded', () => {
    renderTabs();
    renderSubTabs();
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
