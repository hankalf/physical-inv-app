/* Shared by the supervisor pages: the tab bar, the sign-in box, and the
   little API helpers each page would otherwise repeat. */
(() => {
  'use strict';

  /* The pages, in the groups a supervisor thinks in: the counting itself, the
     jobs around it, and how the site is set up. */
  const TABS = [
    ['/admin', 'Dashboard', '▤', 'Counting'],
    ['/cycle', 'Cycle counts', '↻', 'Counting'],
    ['/front', 'Front bins', '▥', 'Warehouse jobs'],
    ['/missing', 'Not in Location', '◎', 'Warehouse jobs'],
    ['/teams', 'Teams & crew', '☰', 'The site'],
    ['/settings', 'Settings', '⚙', 'The site'],
    ['/testing', 'Testing Suite', '▶', 'Learn'],
  ];

  /* Each page's sections, so the sidebar can open them out under the page.
     The current page's list comes from its own markup; the others from here. */
  const SUBS = {
    '/admin': [['progress', 'Progress'], ['map', 'Map'], ['teams', 'Team plan'], ['second', 'Second counts'], ['adjust', 'Adjustments'], ['reports', 'Reports']],
    '/cycle': [['today', 'Today'], ['open', 'Still open'], ['coverage', 'Coverage'], ['setup', 'Program & data']],
    '/teams': [['crew', 'Crew & teams'], ['rules', 'Equipment rules']],
    '/settings': [['start', 'Getting started'], ['gun', 'Scanner screen'], ['logins', 'Logins'], ['scanners', 'Scanners'], ['lists', 'Lists & racking'], ['erp', 'ERP & backups']],
    '/front': [['moves', 'Pallets to move back'], ['bins', 'Front-placed bins']],
    '/missing': [],
    '/testing': [],
  };

  const here = location.pathname.replace(/\/$/, '') || '/admin';

  /* ------------------------------------------------------------- themes
     Kept in this browser, applied before the page draws. Every colour in the
     stylesheet is a token, so a theme is a set of tokens on <html>. */
  const THEMES = [['midnight', 'Midnight (dark blue)'], ['graphite', 'Graphite (dark grey)'], ['daylight', 'Daylight (light)'], ['frost', 'Frost (light, cool)']];
  const ACCENTS = ['blue', 'teal', 'amber', 'berry'];
  const look = { theme: 'midnight', accent: 'blue' };
  try {
    look.theme = THEMES.some(([k]) => k === localStorage.getItem('adminTheme')) ? localStorage.getItem('adminTheme') : 'midnight';
    look.accent = ACCENTS.includes(localStorage.getItem('adminAccent')) ? localStorage.getItem('adminAccent') : 'blue';
  } catch { /* private window */ }
  function applyLook() {
    const root = document.documentElement;
    if (look.theme === 'midnight') root.removeAttribute('data-theme'); else root.dataset.theme = look.theme;
    if (look.accent === 'blue') root.removeAttribute('data-accent'); else root.dataset.accent = look.accent;
    try { localStorage.setItem('adminTheme', look.theme); localStorage.setItem('adminAccent', look.accent); } catch { /* private window */ }
    for (const b of document.querySelectorAll('.themepick .accents button')) b.classList.toggle('on', b.dataset.accent === look.accent);
  }
  applyLook();
  function mountThemePicker() {
    const foot = document.querySelector('.side-foot');
    if (!foot || foot.querySelector('.themepick')) return;
    const box = document.createElement('div');
    box.className = 'themepick';
    const sel = document.createElement('select');
    sel.title = 'How the supervisor pages look, on this computer';
    sel.setAttribute('aria-label', 'Theme');
    for (const [k, l] of THEMES) { const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o); }
    sel.value = look.theme;
    sel.onchange = () => { look.theme = sel.value; applyLook(); };
    const acc = document.createElement('div');
    acc.className = 'accents';
    acc.appendChild(Object.assign(document.createElement('span'), { textContent: 'Accent' }));
    for (const a of ACCENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.accent = a;
      b.title = a[0].toUpperCase() + a.slice(1);
      b.onclick = () => { look.accent = a; applyLook(); };
      acc.appendChild(b);
    }
    box.append(sel, acc);
    foot.prepend(box);
    applyLook();
  }
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
    /** SheetJS, shipped with the app and loaded the first time it is needed. */
    async loadXlsx() {
      if (window.XLSX) return window.XLSX;
      await new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = '/vendor/xlsx.full.min.js';
        sc.onload = res;
        sc.onerror = () => rej(new Error('Could not load the Excel writer.'));
        document.head.appendChild(sc);
      });
      return window.XLSX;
    },
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

  const subsOf = (href) => {
    if (href === here) {
      const panes = [...document.querySelectorAll('[data-sub]')];
      if (panes.length) return panes.map((p) => [p.dataset.sub, p.dataset.subLabel || p.dataset.sub]);
    }
    return SUBS[href] || [];
  };
  const openKey = (href) => 'navOpen:' + href;
  const isOpen = (href) => {
    if (href === here) return true;                 // the page you are on is always opened out
    try { return sessionStorage.getItem(openKey(href)) === '1'; } catch { return false; }
  };

  function renderTabs() {
    const bar = document.getElementById('navTabs');
    if (!bar) return;
    bar.innerHTML = '';
    const currentSub = (location.hash || '').replace('#', '') || (() => { try { return sessionStorage.getItem('sub:' + here); } catch { return ''; } })();
    let lastSection = '';
    for (const [href, label, ico, section] of TABS) {
      if (section !== lastSection) {
        const h = document.createElement('div');
        h.className = 'navsection';
        h.textContent = section;
        bar.appendChild(h);
        lastSection = section;
      }
      const group = document.createElement('div');
      group.className = 'navgroup' + (here === href ? ' here' : '');
      const row = document.createElement('div');
      row.className = 'navrow';
      const a = document.createElement('a');
      a.href = href;
      a.className = 'tab' + (here === href ? ' current' : '');
      const i = document.createElement('span');
      i.className = 'ico';
      i.textContent = ico;
      a.append(i, document.createTextNode(label));
      row.appendChild(a);
      const subs = subsOf(href);
      if (subs.length) {
        /* the sections, opened out under the page; the caret folds them away */
        const open = isOpen(href);
        const caret = document.createElement('button');
        caret.type = 'button';
        caret.className = 'caret';
        caret.textContent = open ? '▾' : '▸';
        caret.title = open ? 'Fold the sections away' : 'Show the sections';
        caret.setAttribute('aria-expanded', String(open));
        row.appendChild(caret);
        const list = document.createElement('div');
        list.className = 'subs';
        list.hidden = !open;
        for (const [sub, text] of subs) {
          const s = document.createElement('a');
          s.href = `${href}#${sub}`;
          s.className = 'sub' + (here === href && sub === currentSub ? ' current' : '');
          // not data-sub: that is how a page marks its own sections, and this is a link to one
          s.dataset.navSub = sub;
          s.dataset.page = href;
          s.textContent = text;
          if (here === href) s.onclick = (e) => { e.preventDefault(); api.showSub(sub); };
          list.appendChild(s);
        }
        caret.onclick = () => {
          const now = list.hidden;
          list.hidden = !now;
          caret.textContent = now ? '▾' : '▸';
          caret.setAttribute('aria-expanded', String(now));
          try { sessionStorage.setItem(openKey(href), now ? '1' : '0'); } catch { /* private window */ }
        };
        group.append(row, list);
      } else {
        group.appendChild(row);
      }
      bar.appendChild(group);
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
    for (const s of document.querySelectorAll(`#navTabs .sub[data-page="${here}"]`)) s.classList.toggle('current', s.dataset.navSub === name);
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


  /* ----------------------------------------------------- the session picker
     Which count you are looking at is context for the whole page, not a field
     in one card, so it lives in the header. A native <select> can only show a
     line of text; these rows carry the type, the state and how far along each
     one is, which is what actually tells two counts apart. */
  const fmtInt = (n) => Number(n || 0).toLocaleString();
  function ago(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 48 * 60) return `${Math.floor(mins / 60)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  api.sessionPicker = function sessionPicker(mountId, onPick) {
    const mount = document.getElementById(mountId);
    if (!mount) return { render() {} };
    mount.classList.add('sesspick');
    mount.innerHTML = '<button type="button" class="sess-btn"></button><div class="sess-menu" hidden></div>';
    const btn = mount.querySelector('.sess-btn');
    const menu = mount.querySelector('.sess-menu');
    let list = [];
    let currentId = null;

    /* Search results need to know which count the page is on, and sometimes to
       move it to another one. */
    api.currentSession = () => currentId;
    api.pickSession = (id) => { if (Number(id) !== currentId) onPick(Number(id)); };

    const close = () => { menu.hidden = true; btn.classList.remove('open'); };
    const open = () => { menu.hidden = false; btn.classList.add('open'); };
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
    document.addEventListener('click', (e) => { if (!mount.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const pct = (s) => (s.bins ? Math.round((s.bins_counted / s.bins) * 100) : 0);
    const kind = (s) => (s.mode === 'cycle' ? 'cycle' : 'full');

    function row(s) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'sess-row' + (s.id === currentId ? ' current' : '') + (s.status === 'closed' ? ' closed' : '');
      el.dataset.id = s.id;
      el.onclick = () => { close(); if (s.id !== currentId) onPick(s.id); };

      const top = document.createElement('div');
      top.className = 'sr-top';
      const k = document.createElement('span');
      k.className = 'sess-kind ' + kind(s);
      k.textContent = kind(s) === 'cycle' ? 'CYCLE' : 'FULL';
      const nm = document.createElement('span');
      nm.className = 'sr-name';
      nm.textContent = s.name;
      top.append(k, nm);
      if (s.practice) {
        const pr = document.createElement('span');
        pr.className = 'tag practice';
        pr.textContent = 'practice';
        pr.title = 'The Testing Suite\'s practice count — not a real count';
        top.appendChild(pr);
      }
      if (s.show_on_guns === 0 && s.status !== 'closed') {
        const h = document.createElement('span');
        h.className = 'tag off';
        h.textContent = 'not on scanners';
        h.title = 'Untick "Show on the scanners" is off for this count';
        top.appendChild(h);
      }
      if (s.status === 'closed') {
        const c = document.createElement('span');
        c.className = 'tag off';
        c.textContent = 'closed';
        top.appendChild(c);
      }
      if (s.recounts_open) {
        const r = document.createElement('span');
        r.className = 'tag queued';
        r.textContent = `${fmtInt(s.recounts_open)} second`;
        r.title = `${fmtInt(s.recounts_open)} second count(s) still open`;
        top.appendChild(r);
      }
      el.appendChild(top);

      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = pct(s) + '%';
      bar.appendChild(fill);
      el.appendChild(bar);

      const meta = document.createElement('div');
      meta.className = 'sr-meta';
      meta.textContent = s.bins
        ? `${fmtInt(s.bins_counted)} of ${fmtInt(s.bins)} bins · ${pct(s)}%`
        : 'no bin list uploaded yet';
      const when = document.createElement('span');
      when.className = 'sr-when';
      when.textContent = s.last_scan ? `last scan ${ago(s.last_scan)}`
        : s.created_at ? `made ${new Date(s.created_at).toLocaleDateString()}` : '';
      meta.appendChild(when);
      el.appendChild(meta);
      return el;
    }

    function render(sessions, id) {
      list = sessions || [];
      currentId = id == null ? null : Number(id);
      const s = list.find((x) => x.id === currentId);
      btn.innerHTML = '';
      if (!s) {
        btn.className = 'sess-btn empty';
        btn.textContent = list.length ? 'Pick a count' : 'No count session yet';
        btn.appendChild(Object.assign(document.createElement('span'), { className: 'caret', textContent: '▾' }));
      } else {
        btn.className = 'sess-btn';
        const k = document.createElement('span');
        k.className = 'sess-kind ' + kind(s);
        k.textContent = kind(s) === 'cycle' ? 'CYCLE' : 'FULL';
        const nm = document.createElement('span');
        nm.className = 'sb-name';
        nm.textContent = s.name;
        btn.append(k, nm);
        if (s.practice) {
          const pr = document.createElement('span');
          pr.className = 'tag practice';
          pr.textContent = 'practice';
          btn.appendChild(pr);
        }
        if (s.status === 'closed') {
          const c = document.createElement('span');
          c.className = 'tag off';
          c.textContent = 'closed';
          btn.appendChild(c);
        } else if (s.bins) {
          const p = document.createElement('span');
          p.className = 'sb-pct';
          p.textContent = pct(s) + '%';
          btn.appendChild(p);
        }
        btn.appendChild(Object.assign(document.createElement('span'), { className: 'caret', textContent: '▾' }));
        btn.title = `${s.name} — ${kind(s) === 'cycle' ? 'cycle count' : 'full count'}, ${s.status}`;
      }

      menu.innerHTML = '';
      const openOnes = list.filter((x) => x.status !== 'closed');
      const shut = list.filter((x) => x.status === 'closed');
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'sess-empty';
        e.textContent = 'No count sessions yet. Create one below.';
        menu.appendChild(e);
      }
      for (const [label, group] of [['Open', openOnes], ['Closed', shut]]) {
        if (!group.length) continue;
        const h = document.createElement('div');
        h.className = 'sess-head';
        h.textContent = `${label} · ${group.length}`;
        menu.appendChild(h);
        for (const x of group) menu.appendChild(row(x));
      }
    }
    return { render, close };
  };

  /* ------------------------------------------------------------- search
   * One box that finds anything.
   *
   * A supervisor's question is rarely "open the pallet report": it is "where is
   * pallet F02-118", "who counted F01A005", "which team has F04", "where do I
   * upload the bin list". Knowing which of four pages and twenty cards answers
   * that is fine after a month and hopeless on day one, so this asks everywhere
   * at once - the data through the server, and the app's own screens from the
   * list below.
   *
   * It lives in the sidebar, which every supervisor page shares, so it is in the
   * same place wherever you are.
   */
  const PLACES = [
    ['Count progress, teams and totals', '/admin', 'progress', 'progress dashboard totals lines bins percent complete teams counting how far'],
    ['Count session settings', '/admin', 'progress', 'settings options pallet check guided comments lot expiry recount thresholds approval abc close delete session'],
    ['Note on the office board', '/admin', 'progress', 'note board break lunch message wall screen tv'],
    ['Start a new count', '/admin', 'progress', 'new count create session wall-to-wall cycle start'],
    ['Warehouse map', '/admin', 'map', 'map drawing racking aisles bays picture layout blueprint'],
    ['Team assignments', '/admin', 'teams', 'assign aisles teams plan queue blocks racking give aisle levels'],
    ['Message the floor', '/admin', 'teams', 'message scanners guns floor tell team radio broadcast'],
    ['Second counts', '/admin', 'second', 'recount second count variance go back check again task'],
    ['Adjustments and approvals', '/admin', 'adjust', 'adjustment approve approval reason code sign off erp variance write off'],
    ['Pallet report', '/admin', 'reports', 'pallet report variance exceptions missing wrong bin counted twice status'],
    ['Find a lot', '/admin', 'reports', 'lot batch recall find trace expiry'],
    ['Count accuracy by ABC class', '/admin', 'reports', 'accuracy abc class kpi target percent quality score'],
    ['Labels to replace', '/admin', 'reports', 'label barcode unreadable relabel print rack tag damaged'],
    ['Printable count sheets', '/admin', 'reports', 'print paper count sheet blind auditor pen'],
    ['Cycle count programme', '/cycle', '', 'cycle batch schedule daily weekly oldest abc coverage programme'],
    ['Crew list and equipment', '/teams', 'crew', 'crew employee badge clock in number people roster equipment forklift scissor reach'],
    ['Teams and who is on them', '/teams', 'teams', 'team member crew drag assign people'],
    ['Level rules for equipment', '/teams', 'rules', 'level rules reach equipment which levels forklift high reach'],
    ['Getting started checklist', '/settings', 'start', 'getting started checklist setup first time what next'],
    ['Scanner screen layout', '/settings', 'gun', 'scanner screen questions order keyboard text size upright portrait update comments countdown gun handheld'],
    ['Supervisor logins', '/settings', 'logins', 'login user password account supervisor admin shared'],
    ['Scanner setup and links', '/settings', 'scanners', 'scanner device link qr register enrol setup card handheld gun'],
    ['One-tap reasons on the gun', '/settings', 'scanners', 'reason comment override one tap chips damaged'],
    ['Adjustment reasons and accuracy targets', '/settings', 'scanners', 'adjustment reason code accuracy target abc percent'],
    ['Upload the bin list', '/settings', 'lists', 'bin list locations upload import csv excel master file racking'],
    ['Upload the inventory report', '/settings', 'lists', 'inventory report pallets upload import csv excel expected quantity erp export'],
    ['Upload a counting plan', '/settings', 'lists', 'plan counting plan teams aisles upload csv'],
    ['Racking blocks', '/settings', 'lists', 'racking block back to back pair aisles conflict'],
    ['Send to the ERP', '/settings', 'erp', 'erp export send file layout columns adjustments posting'],
    ['Backups and the log', '/settings', 'erp', 'backup restore log audit who did what download'],
    ['Testing Suite — try the scanner on test data', '/testing', '', 'testing suite test practice training try demo scanner gun emulator simulator learn new starter'],
    ['Export everything to Excel', '/admin', 'reports', 'export everything excel workbook xlsx all data readable download report auditor'],
    ['Trial run — rehearse, then clear', '/admin', 'progress', 'trial run rehearsal dry run practice clear reset start fresh'],
    ['Positive and negative adjustments', '/admin', 'adjust', 'adjustments positive negative found more less add take off net variance'],
    ['Team clocks and stopped scanning', '/admin', 'progress', 'timer clock time on count idle stopped scanning quiet break lunch alert'],
    ['Stopped-scanning alert setting', '/settings', 'scanners', 'idle stopped scanning minutes alert teams break'],
    ['1st and 2nd shift teams', '/teams', 'crew', 'shift first second 1st 2nd night day team'],
    ['Front bins — the list, and pallets to move back', '/front', 'bins', 'front back face placed bins list cycle aisle side move pallets behind empty'],
    ['Not in Location — pallets the system has lost track of', '/missing', '', 'not in location missing lost pallets find locate last known location where is written off'],
    ['Fix list — damage, blocked bins, labels to replace', '/admin', 'reports', 'fix list damage damaged racking beam blocked bin trailer relabel labels replace repair problems reported'],
    ['Pallets to move back — front bins with an empty bin behind', '/front', 'moves', 'move pallets back front behind empty double deep relocate'],
    ['Auto-assign the aisles — a staggered plan', '/admin', 'teams', 'auto assign plan stagger staggered aisles teams spread automatic queue every team'],
    ['Test with your own pallets, and try features that are off', '/testing', '', 'testing upload own pallets file lot expiry approval abc try features off practice'],
  ].map(([title, page, sub, words]) => ({ title, page, sub, words }));

  const PENDING = 'searchGoto';
  let searchTimer = null;
  let searchRows = [];
  let searchAt = -1;

  function mountSearch() {
    const side = document.querySelector('aside.side');
    if (!side || document.getElementById('navSearch')) return;
    const box = document.createElement('div');
    box.className = 'navsearch';
    box.innerHTML = '<input id="navSearch" type="search" autocomplete="off" spellcheck="false"'
      + ' placeholder="Search anything…" aria-label="Search anything">'
      + '<div class="results" id="navResults" hidden></div>';
    side.insertBefore(box, side.querySelector('#navTabs'));
    const input = box.querySelector('#navSearch');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(input.value), 180);
    });
    input.addEventListener('keydown', onSearchKey);
    input.addEventListener('focus', () => { if (input.value.trim().length > 1) runSearch(input.value); });
    document.addEventListener('click', (e) => { if (!box.contains(e.target)) closeSearch(); });
    /* "/" is the one key nobody types into a warehouse form by accident, and
       ctrl-K is what everybody's fingers already do. */
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function closeSearch() {
    const r = document.getElementById('navResults');
    if (r) r.hidden = true;
    searchAt = -1;
  }

  function onSearchKey(e) {
    const panel = document.getElementById('navResults');
    if (e.key === 'Escape') { closeSearch(); e.target.blur(); return; }
    if (!panel || panel.hidden || !searchRows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      searchAt = (searchAt + (e.key === 'ArrowDown' ? 1 : -1) + searchRows.length) % searchRows.length;
      highlightSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      goSearch(searchRows[Math.max(0, searchAt)]);
    }
  }

  function highlightSearch() {
    const panel = document.getElementById('navResults');
    if (!panel) return;
    const items = [...panel.querySelectorAll('.hit')];
    items.forEach((el, i) => el.classList.toggle('on', i === searchAt));
    if (items[searchAt]) items[searchAt].scrollIntoView({ block: 'nearest' });
  }

  /** The app's own screens, matched on what a person would call them. */
  function placeHits(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return PLACES
      .map((pl) => {
        const hay = (pl.title + ' ' + pl.words).toLowerCase();
        const score = words.reduce((n, w) => n + (hay.includes(w) ? (pl.title.toLowerCase().includes(w) ? 2 : 1) : 0), 0);
        return { pl, score };
      })
      .filter((x) => x.score >= words.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => ({
        title: x.pl.title,
        detail: `${x.pl.page.replace('/', '')}${x.pl.sub ? ' → ' + x.pl.sub : ''}`,
        goto: { page: x.pl.page, sub: x.pl.sub },
      }));
  }

  async function runSearch(raw) {
    const q = String(raw || '').trim();
    const panel = document.getElementById('navResults');
    if (!panel) return;
    if (q.length < 2) { closeSearch(); return; }
    const groups = [];
    const places = placeHits(q);
    if (places.length) groups.push({ kind: 'Go to', rows: places });
    try {
      const sess = api.currentSession ? api.currentSession() : 0;
      const data = await api.json(`/api/admin/search?q=${encodeURIComponent(q)}&session=${sess || 0}`);
      groups.push(...(data.groups || []));
    } catch { /* signed out, or offline: the screens above still work */ }
    renderSearch(q, groups);
  }

  function renderSearch(q, groups) {
    const panel = document.getElementById('navResults');
    panel.innerHTML = '';
    searchRows = [];
    searchAt = -1;
    if (!groups.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = `Nothing matching “${q}”.`;
      panel.appendChild(none);
      panel.hidden = false;
      return;
    }
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = g.kind;
      panel.appendChild(h);
      for (const row of g.rows) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'hit';
        const t = document.createElement('b');
        t.textContent = row.title;
        const d = document.createElement('span');
        d.textContent = row.detail || '';
        el.append(t, d);
        el.onclick = () => goSearch(row);
        panel.appendChild(el);
        searchRows.push(row);
      }
    }
    panel.hidden = false;
  }

  /**
   * Take the supervisor there.
   *
   * On this page it is a sub-tab away; on another it is a page load, so what to
   * do on arrival is left in the tab's own storage and picked up on the way in.
   */
  function goSearch(row) {
    if (!row || !row.goto) return;
    const g = row.goto;
    closeSearch();
    const target = (g.page || here).replace(/\/$/, '');
    if (target === here) { applyGoto(g); return; }
    try { sessionStorage.setItem(PENDING, JSON.stringify(g)); } catch { /* private window */ }
    location.href = target + (g.sub ? '#' + g.sub : '');
  }

  /** Send the supervisor to another page, arriving on a count and a sub-tab. */
  api.goto = (g) => goSearch({ goto: g });

  function applyGoto(g) {
    if (g.session && api.pickSession) api.pickSession(g.session);
    if (g.sub) api.showSub(g.sub);
    /* Some hits are a field rather than a card - a lot code belongs in the lot
       box, typed and asked for, not just nearby. */
    setTimeout(() => {
      const el = g.focus && document.getElementById(g.focus);
      if (el) {
        if (g.value != null) el.value = g.value;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.focus();
        const card = el.closest('.card');
        if (card) { card.classList.add('found'); setTimeout(() => card.classList.remove('found'), 2200); }
        if (g.press) document.getElementById(g.press)?.click();
      }
    }, g.sub ? 250 : 0);
  }

  /** Anything left for us by a search on the page before this one. */
  function applyPendingGoto() {
    let g = null;
    try {
      const raw = sessionStorage.getItem(PENDING);
      if (!raw) return;
      sessionStorage.removeItem(PENDING);
      g = JSON.parse(raw);
    } catch { return; }
    if (g) setTimeout(() => applyGoto(g), 400);
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderTabs();
    mountThemePicker();
    mountSearch();
    renderSubTabs();
    applyPendingGoto();
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
