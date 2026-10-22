/* Settings: count setup, list uploads, racking blocks, the scanners, integrations, backups, and the logins and the site's look,
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
    msg(el, 'err', 'There is no count session yet', 'Make one under Count setup → Count session, then come back here.');
    return false;
  };

  const titleCase = (z) => String(z || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const aisleLabel = (aisle, zone) => (zone ? `${titleCase(zone)} – Aisle ${aisle}` : `Aisle ${aisle}`);


  /* ------------------------------------------------------- getting started
     A checklist the server works out from the database, so it can never claim
     something is done that is not. Each step says why it matters and takes you
     to the place that does it. */
  const NEED_LABEL = { required: 'needed to start', wanted: 'recommended', optional: 'optional' };

  async function refreshSetup() {
    const box = $('startSteps');
    if (!sessionId) {
      box.innerHTML = '';
      $('startSub').textContent = '';
      $('startBar').style.width = '0%';
      msg($('startMsg'), 'warn', 'No count picked yet', 'Create one on the Dashboard, then come back here.');
      return;
    }
    const st = await api.json(`/api/admin/sessions/${sessionId}/setup`);
    clearMsg($('startMsg'));
    $('startSub').textContent = `${st.session.name} · ${st.session.mode === 'cycle' ? 'cycle count' : 'full count'}`;
    $('startBar').style.width = Math.round((st.done / st.total) * 100) + '%';

    if (st.started) {
      msg($('startMsg'), 'ok', `This count is running — ${st.counted.toLocaleString()} bins have a count already.`,
        'Anything still open below can be filled in as you go.');
    } else if (st.ready) {
      msg($('startMsg'), 'ok', 'Ready to count.', 'Everything needed is in place. Hand the scanners out.');
    } else {
      msg($('startMsg'), 'warn', `${st.blocking.length} thing(s) still needed before anyone can scan.`,
        'The rest is recommended rather than required.');
    }

    box.innerHTML = '';
    for (const step of st.steps) {
      const li = document.createElement('li');
      const blocking = !step.done && step.need === 'required';
      li.className = step.done ? 'done' : blocking ? 'blocking' : '';

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = step.done ? '✓' : blocking ? '!' : '·';
      li.appendChild(mark);

      const mid = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'st-title';
      title.append(step.title);
      if (!step.done) {
        const tag = document.createElement('span');
        tag.className = 'tag ' + (step.need === 'required' ? 'off' : step.need === 'wanted' ? 'queued' : '');
        tag.textContent = NEED_LABEL[step.need];
        title.appendChild(tag);
      }
      const why = document.createElement('div');
      why.className = 'st-why';
      why.textContent = step.why;
      const detail = document.createElement('div');
      detail.className = 'st-detail';
      detail.textContent = step.detail;
      mid.append(title, why, detail);
      li.appendChild(mid);

      const go = button(step.done ? 'Change it' : step.label, 'sm' + (blocking ? ' primary' : ''), () => {
        if (step.goto.page === '/settings') { api.showSub(step.goto.sub); window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else location.href = `${step.goto.page}#${step.goto.sub}`;
      });
      li.appendChild(go);
      box.appendChild(li);
    }
  }

  /* ------------------------------------------------------------ accounts */
  async function refreshMe() {
    me = await api.json('/api/admin/me');
    const isAdmin = me.role === 'admin';
    $('adminOnly').hidden = !isAdmin;
    $('notAdmin').hidden = isAdmin;
    $('ownPassword').hidden = false;
    if (isAdmin) await refreshUsers();
  }

  /* Addresses locked for trying too many logins at once - rare, so only shown when there is one. */
  function drawPlaceLocks(list) {
    const box = $('placeLocks');
    if (!box) return;
    box.hidden = !list.length;
    box.replaceChildren();
    for (const l of list) {
      const row = document.createElement('div');
      row.className = 'feedback warn show';
      row.append(`Address ${l.ip} is locked for another ${l.minutes} min after too many wrong passwords. `);
      row.appendChild(button('Unlock', 'sm', async () => {
        try { await api.post('/api/admin/login-locks/unlock', { ip: l.ip }); await refreshUsers(); }
        catch (err) { msg($('userMsg'), 'err', err.message); }
      }));
      box.appendChild(row);
    }
  }

  async function refreshUsers() {
    const { users, locks = [], systems = [], self = null } = await api.json('/api/admin/users');
    const lockOf = (name) => locks.find((l) => l.username === name);
    drawCopyLogins(systems, self);
    const newSys = $('fNewSystems');
    if (newSys) {
      newSys.hidden = !systems.length;
      const have = [...newSys.querySelectorAll('input')].map((b) => b.dataset.system).join('|');
      if (have !== systems.map((x) => x.name).join('|')) {
        newSys.replaceChildren(Object.assign(document.createElement('span'), { className: 'muted', textContent: `Signs in on ${self ? self.name : 'this system'}; may also switch to ` }));
        for (const sy of systems) {
          const l = Object.assign(document.createElement('label'), { className: 'cb' });
          const b = Object.assign(document.createElement('input'), { type: 'checkbox' });
          b.dataset.system = sy.name;
          l.append(b, document.createTextNode(' ' + sy.name));
          newSys.appendChild(l);
        }
      }
    }
    drawPlaceLocks(locks.filter((l) => !l.username));
    const keys = (api.me && api.me.accessKeys) || [];
    table($('userTable'),
      [{ label: 'Username' }, { label: 'Name' }, { label: 'Role' }, { label: 'May use' }, ...(systems.length ? [{ label: 'Systems' }] : []), { label: 'Status' }, { label: 'Last signed in' }, { label: 'Added' }, { label: '' }],
      users,
      (u) => {
        const tr = document.createElement('tr');
        tr.append(cell(u.username));
        const tdName = cell(u.name, 'wrap');
        if (u.email) { const em = document.createElement('div'); em.className = 'muted'; em.style.fontSize = '12px'; em.textContent = u.email; tdName.appendChild(em); }
        tr.appendChild(tdName);
        const tdRole = document.createElement('td');
        /* the role is a picker: a preset of the list, or Admin; ticking by hand shows as Custom */
        const profiles = (api.me && api.me.profiles) || [];
        const rsel = document.createElement('select');
        rsel.className = 'sm rolepick';
        for (const pr of profiles) {
          if (pr.key === 'custom' && u.profile !== 'custom') continue;
          const o = document.createElement('option'); o.value = pr.key; o.textContent = pr.label.split(' — ')[0]; o.title = pr.label; rsel.appendChild(o);
        }
        rsel.value = u.profile || (u.role === 'admin' ? 'admin' : 'supervisor');
        rsel.title = (profiles.find((pr) => pr.key === rsel.value) || {}).label || '';
        rsel.onchange = async () => {
          try { await api.post(`/api/admin/users/${u.username}`, { profile: rsel.value }); clearMsg($('userMsg')); await refreshUsers(); }
          catch (err) { msg($('userMsg'), 'err', err.message); await refreshUsers(); }
        };
        tdRole.appendChild(rsel);
        tr.appendChild(tdRole);
        /* what this login may use: a drop-down checklist for a supervisor, one word for an admin */
        const tdAcc = document.createElement('td');
        tdAcc.className = 'access';
        if (u.role === 'admin') {
          tdAcc.textContent = 'everything';
          tdAcc.title = 'An admin may use every page and every function, Settings included.';
        } else {
          const list = Array.isArray(u.access) ? u.access : keys.map(([k]) => k);
          const pick = document.createElement('details');
          pick.className = 'accpick';
          const sum = document.createElement('summary');
          const panel = document.createElement('div');
          panel.className = 'accpanel';
          const pickedNow = () => {
            const whole = [...panel.querySelectorAll('input[data-access]:checked')].map((i) => i.dataset.access);
            const tabs = [...panel.querySelectorAll('input[data-tab]:checked')].map((i) => i.dataset.tab).filter((t) => !whole.includes(t.split('.')[0]));
            return [...whole, ...tabs];
          };
          const say = () => {
            const on = pickedNow();
            const pages = keys.filter(([k, , kind]) => kind === 'page' && (on.includes(k) || on.some((x) => x.startsWith(k + '.')))).length;
            const partial = keys.filter(([k, , kind]) => kind === 'page' && !on.includes(k) && on.some((x) => x.startsWith(k + '.'))).length;
            const fns = keys.filter(([k, , kind]) => kind === 'function' && on.includes(k)).length;
            const allPages = keys.filter(([, , kind]) => kind === 'page').length;
            const allFns = keys.filter(([, , kind]) => kind === 'function').length;
            const match = (api.me.profiles || []).find((pr) => Array.isArray(pr.access) && pr.access.length === on.length && pr.access.every((k) => on.includes(k)));
            sum.textContent = pages === allPages && fns === allFns && !partial ? 'Everything a supervisor can'
              : match ? `${match.label.split(' — ')[0]} · ${pages} of ${allPages} pages · ${fns} of ${allFns} functions`
                : `${pages} of ${allPages} pages${partial ? ` (${partial} in part)` : ''} · ${fns} of ${allFns} functions`;
          };
          const save = async () => {
            const picked = pickedNow();
            say();
            try {
              await api.post(`/api/admin/users/${u.username}`, { access: picked }); clearMsg($('userMsg'));
              const fresh = (await api.json('/api/admin/users')).users.find((x) => x.username === u.username);
              const rs = tr.querySelector('select.rolepick');
              if (fresh && rs) {
                if (fresh.profile === 'custom' && ![...rs.options].some((o) => o.value === 'custom')) { const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Custom'; rs.appendChild(o); }
                rs.value = fresh.profile;
              }
            } catch (err) { msg($('userMsg'), 'err', err.message); }
          };
          const tabsOf = (api.me && api.me.tabs) || {};
          for (const group of ['page', 'function']) {
            const h = document.createElement('div');
            h.className = 'acchead';
            h.textContent = group === 'page' ? 'Pages they may open — and which tabs' : 'What they can also do';
            panel.appendChild(h);
            for (const [k, label, kind] of keys) {
              if (kind !== group) continue;
              const l = document.createElement('label');
              l.className = 'cb';
              const i = document.createElement('input');
              i.type = 'checkbox'; i.dataset.access = k; i.checked = list.includes(k);
              l.append(i, ' ', label);
              panel.appendChild(l);
              const subs = kind === 'page' ? (tabsOf[k] || []) : [];
              if (subs.length) {
                /* the page's tabs, indented: the whole page ticks them all; untick the page to pick tabs */
                const row = document.createElement('div');
                row.className = 'acctabs';
                for (const [sub, slabel] of subs) {
                  const tl = document.createElement('label');
                  tl.className = 'cb';
                  const ti = document.createElement('input');
                  ti.type = 'checkbox'; ti.dataset.tab = `${k}.${sub}`;
                  ti.checked = list.includes(k) || list.includes(`${k}.${sub}`);
                  ti.disabled = list.includes(k);
                  ti.onchange = save;
                  tl.append(ti, ' ', slabel);
                  row.appendChild(tl);
                }
                panel.appendChild(row);
                i.onchange = () => { for (const ti of row.querySelectorAll('input')) { ti.checked = i.checked; ti.disabled = i.checked; } save(); };
              } else i.onchange = save;
            }
          }
          const note = document.createElement('div');
          note.className = 'muted';
          note.textContent = 'Settings is for admins only.';
          panel.appendChild(note);
          pick.append(sum, panel);
          /* The table sits in a scroll box, which would clip a panel inside it,
             so the open panel floats over the page from where the button is.
             One open at a time; an outside click or a scroll closes it. */
          const place = () => {
            const r = sum.getBoundingClientRect();
            panel.style.top = `${Math.min(r.bottom + 4, window.innerHeight - panel.offsetHeight - 8)}px`;
            panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
          };
          pick.addEventListener('toggle', () => {
            if (!pick.open) return;
            for (const o of document.querySelectorAll('details.accpick[open]')) if (o !== pick) o.open = false;
            place();
            const away = (e) => { if (!pick.contains(e.target)) { pick.open = false; document.removeEventListener('click', away, true); } };
            setTimeout(() => document.addEventListener('click', away, true), 0);
            const onScroll = () => { if (pick.open) place(); else window.removeEventListener('scroll', onScroll, true); };
            window.addEventListener('scroll', onScroll, true);
          });
          say();
          tdAcc.appendChild(pick);
        }
        tr.appendChild(tdAcc);
        /* Which systems: this one always, the others ticked. Their login and what it may use come
           with them when they switch, so nobody needs a second login on the other system. */
        if (systems.length) {
          const tdSys = document.createElement('td');
          tdSys.className = 'syscell';
          const here = Object.assign(document.createElement('label'), { className: 'cb', title: `Everyone signs in on ${self ? self.name : 'this system'}` });
          here.append(Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, disabled: true }), document.createTextNode(' ' + (self ? self.name : 'This one')));
          tdSys.appendChild(here);
          for (const sy of systems) {
            const l = Object.assign(document.createElement('label'), { className: 'cb' });
            const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: u.role === 'admin' || (u.systems || []).includes(sy.name), disabled: u.role === 'admin' || !u.active });
            box.dataset.userSystem = sy.name;
            l.title = u.role === 'admin' ? 'An admin may use every system' : `May ${u.name || u.username} switch to ${sy.name}?`;
            box.onchange = async () => {
              const want = [...tdSys.querySelectorAll('input[data-user-system]')].filter((b) => b.checked).map((b) => b.dataset.userSystem);
              try {
                await api.post('/api/admin/systems/access', { username: u.username, systems: want });
                msg($('userMsg'), 'ok', `${u.name || u.username}: ${[self ? self.name : '', ...want].filter(Boolean).join(' and ')}`, want.length ? `They switch with the sidebar's Switch to…, or pick it at sign-in — no second login needed.` : '');
                refreshSystems().catch(() => {});
              } catch (err) { box.checked = !box.checked; msg($('userMsg'), 'err', err.message); }
            };
            l.append(box, document.createTextNode(' ' + sy.name));
            tdSys.appendChild(l);
          }
          tr.appendChild(tdSys);
        }
        const tdSt = document.createElement('td');
        tdSt.appendChild(u.active ? tag('active') : tag('off'));
        if (u.active && u.mustChange) {
          const w = tag('starter');
          w.title = 'Still on the password they were given — they choose their own at their next sign-in.';
          w.style.marginLeft = '4px';
          tdSt.appendChild(w);
        }
        if (u.active && u.invited && !u.last_login) {
          const w = tag('queued', 'invited');
          w.title = `Invite sent — the link works until ${new Date(u.inviteExpires).toLocaleString()}.`;
          w.style.marginLeft = '4px';
          tdSt.appendChild(w);
        }
        const lk = lockOf(u.username);
        if (lk) {
          const w = tag('off', 'locked');
          w.title = `Too many wrong passwords from ${lk.ip} — locked for another ${lk.minutes} min.`;
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
        if (lk) act.appendChild(button('Unlock', 'sm', async () => {
          try { await api.post('/api/admin/login-locks/unlock', { username: u.username }); msg($('userMsg'), 'ok', `${u.username} can sign in again`); await refreshUsers(); }
          catch (err) { msg($('userMsg'), 'err', err.message); }
        }));
        act.appendChild(button(u.active ? 'Deactivate' : 'Reactivate', 'sm', () =>
          change({ active: !u.active }, u.active ? `Deactivate ${u.username}? They will not be able to sign in.` : '')));
        if (u.email && u.active) act.appendChild(button(u.invited ? 'Invite again' : 'Invite', 'sm', async () => {
          try {
            const inv = await api.post(`/api/admin/users/${u.username}/invite`, {});
            clearMsg($('userMsg'));
            showInvite({ ...inv, email: u.email, name: u.name });
            await refreshUsers();
          } catch (err) { msg($('userMsg'), 'err', err.message); }
        }));
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
      }, 'No logins yet besides the superadmin.');
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

  /* An invite is a link, not a password: it goes out from the admin's own email
     (so it comes from someone the person knows), or is copied into a message.
     It works once, for three days, and asks its owner to choose a password. */
  function showInvite(inv) {
    $('starterBox').style.display = 'none';
    const box = $('inviteBox');
    box.style.display = 'block';
    box.className = 'feedback show ok';
    box.replaceChildren();
    const until = new Date(inv.expiresAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const head = document.createElement('div');
    head.textContent = `Invite for ${inv.username}${inv.email ? ` (${inv.email})` : ''} — works once, until ${until}.`;
    const link = document.createElement('input');
    link.id = 'inviteLink'; link.readOnly = true; link.value = inv.link; link.style.cssText = 'width:100%;margin:8px 0;font-family:ui-monospace,monospace;font-size:12px';
    link.onclick = () => link.select();
    const site = (api.brand && api.brand().name) || 'Full Harvest Inventory';
    const subject = `Your login for ${site}`;
    const body = `Hi ${inv.name || inv.username},\n\nYou have a login for ${site}. Your username is ${inv.username}.\n\nOpen this link to choose your password and sign in:\n${inv.link}\n\nThe link works once, until ${until}. If it runs out, ask for a new one.\n`;
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const mail = document.createElement('a');
    mail.className = 'btn primary'; mail.id = 'btnInviteMail';
    mail.href = `mailto:${encodeURIComponent(inv.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    mail.textContent = 'Email the invite';
    const copy = button('Copy link', '', async () => {
      try { await navigator.clipboard.writeText(inv.link); copy.textContent = 'Copied'; } catch { link.select(); document.execCommand('copy'); copy.textContent = 'Copied'; }
    });
    copy.id = 'btnInviteCopy';
    const why = document.createElement('div');
    why.className = 'detail';
    why.textContent = 'Email the invite opens a new message in your own email, ready to send. The link is shown once; a new invite replaces it.';
    bar.append(mail, copy);
    box.append(head, link, bar, why);
  }

  /* Copy logins from TEST: what is there, what would happen to each, then the ticked ones copied. */
  function drawCopyLogins(systems, self) {
    const box = $('copyLoginsBox');
    if (!box) return;
    box.hidden = !systems.length || !self || self.role !== 'home';
    const btns = $('copyLoginsBtns');
    const have = [...btns.querySelectorAll('button')].map((b) => b.dataset.copyFrom).join('|');
    if (have === systems.map((x) => x.name).join('|')) return;
    btns.replaceChildren();
    for (const sy of systems) {
      const b = button(`Copy logins from ${sy.name}`, 'sm', () => previewCopy(sy.name));
      b.dataset.copyFrom = sy.name;
      b.title = `The logins made on ${sy.name}, brought here with their passwords — you see the list first`;
      btns.appendChild(b);
    }
    btns.appendChild(Object.assign(document.createElement('span'), { className: 'muted', style: 'font-size:12.5px',
      textContent: `for logins someone made on ${systems.map((x) => x.name).join(' or ')} before it was linked — they keep their passwords` }));
  }
  const COPY_WORD = { new: 'copied here, same password', here: 'already a login here — left as it is', invite: 'never chose a password — add them here and invite them' };
  async function previewCopy(name, done = null) {
    const panel = $('copyLogins');
    panel.hidden = false;
    panel.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: `Asking ${name} for its logins…` }));
    if (!done) clearMsg($('copyLoginsMsg'));
    let pv;
    try { pv = await api.post('/api/admin/systems/logins', { name }); }
    catch (err) { panel.hidden = true; msg($('copyLoginsMsg'), 'err', err.message); return; }
    panel.replaceChildren();
    const tbl = document.createElement('table');
    tbl.id = 'copyLoginsTable';
    panel.appendChild(tbl);
    table(tbl, [{ label: '' }, { label: 'Username' }, { label: 'Name' }, { label: 'Role' }, { label: `On ${name}` }, { label: 'Copying it' }], pv.logins, (u) => {
      const tr = document.createElement('tr');
      tr.dataset.user = u.username;
      const td = document.createElement('td');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', disabled: u.status !== 'new', checked: u.status === 'new' && !u.startup });
      box.dataset.copy = u.username;
      td.appendChild(box);
      tr.append(td, cell(u.username), cell(u.name + (u.email ? ` · ${u.email}` : '')), cell(u.role === 'admin' ? 'Admin' : 'Supervisor'),
        cell(`${u.active ? 'active' : 'deactivated'}${u.startup ? ` · ${name}'s superadmin` : ''}`),
        cell(u.status === 'new' && u.startup ? `${COPY_WORD.new} — not ticked: it is ${name}'s own setup login` : COPY_WORD[u.status]));
      if (u.status !== 'new') tr.className = 'muted';
      return tr;
    }, `${name} has no logins of its own — everyone there came from here.`);
    const fresh = pv.logins.filter((u) => u.status === 'new').length;
    const bar = document.createElement('div');
    bar.className = 'inline';
    bar.style.marginTop = '8px';
    const go = button('Copy the ticked logins', 'primary sm', async () => {
      const usernames = [...tbl.querySelectorAll('input[data-copy]:checked')].map((b) => b.dataset.copy);
      if (!usernames.length) return msg($('copyLoginsMsg'), 'warn', 'Nothing ticked.');
      if (!confirm(`Copy ${usernames.length} login${usernames.length === 1 ? '' : 's'} from ${name} to ${thisSystem().name}? They sign in here with the password they use on ${name}.`)) return;
      go.disabled = true;
      try {
        const out = await api.post('/api/admin/systems/logins', { name, copy: true, usernames });
        msg($('copyLoginsMsg'), out.copied.length ? 'ok' : 'warn',
          out.copied.length ? `Copied ${out.copied.length} from ${name}: ${out.copied.join(', ')}` : 'Nothing copied',
          [out.copied.length ? `They sign in here with the password they use on ${name}, and may still switch to ${name}.` : '',
            out.skipped.length ? `Skipped: ${out.skipped.map((x) => `${x.username} (${x.why})`).join('; ')}.` : ''].filter(Boolean).join(' '));
        await refreshUsers();
        refreshSystems().catch(() => {});
        await previewCopy(name, true);
      } catch (err) { go.disabled = false; msg($('copyLoginsMsg'), 'err', err.message); }
    });
    go.disabled = !fresh;
    const close = button('Close', 'sm ghost', () => { panel.hidden = true; panel.replaceChildren(); });
    bar.append(go, close, Object.assign(document.createElement('span'), { className: 'muted', style: 'font-size:12.5px',
      textContent: fresh ? `${fresh} of ${pv.logins.length} can be copied. Nobody here is changed.` : `Nothing new to copy from ${name}.` }));
    panel.appendChild(bar);
  }
  const thisSystem = () => (api.me && api.me.system) || { name: 'this system' };

  $('fNewEmail').addEventListener('input', () => { if ($('fNewEmail').value.includes('@') && !$('fNewPass').value) $('fNewInvite').checked = true; });
  $('btnAddUser').onclick = async () => {
    try {
      const invite = $('fNewInvite').checked;
      const u = await api.post('/api/admin/users', {
        username: $('fNewUser').value, name: $('fNewFullName').value, email: $('fNewEmail').value,
        password: invite ? '' : $('fNewPass').value, profile: $('fNewRole').value, invite,
      });
      const also = [...document.querySelectorAll('#fNewSystems input:checked')].map((b) => b.dataset.system);
      if (also.length && u.role !== 'admin') await api.post('/api/admin/systems/access', { username: u.username, systems: also }).catch((err) => msg($('userMsg'), 'err', err.message));
      for (const b of document.querySelectorAll('#fNewSystems input')) b.checked = false;
      $('fNewUser').value = ''; $('fNewFullName').value = ''; $('fNewPass').value = ''; $('fNewEmail').value = ''; $('fNewInvite').checked = false;
      if (u.invite) { clearMsg($('userMsg')); showInvite({ ...u.invite, name: u.name }); }
      else if (u.starterPassword) { clearMsg($('userMsg')); $('inviteBox').style.display = 'none'; showStarter(u.username, u.starterPassword); }
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



  /* ------------------------------------------------- the scanner screen
     The preview is an iframe loading the gun's own stylesheet, at the real
     pixel size of the device. Same CSS as the handheld, so it cannot drift
     from what a counter actually sees. */
  const DEVICES = {
    mc9090: { w: 240, h: 320, name: 'MC9090', note: '3.8" QVGA · 240 × 320' },
    mc9200: { w: 480, h: 640, name: 'MC9200', note: '3.7" VGA · 480 × 640' },
  };
  const STEP_INFO = {
    pallet: { what: 'Pallet ID', sub: 'scan the label on the pallet or container', prompt: 'Scan PALLET ID', ph: '' },
    qty:    { what: 'Quantity',  sub: 'how many are on it',                        prompt: 'Enter QUANTITY', ph: '' },
    bin:    { what: 'Bin',       sub: 'scan the location label',                   prompt: 'Scan BIN LOCATION', ph: '' },
    lot:    { what: 'Lot code',  sub: 'only on counts that track lots',            prompt: 'Scan LOT CODE', ph: '' },
    expiry: { what: 'Expiry',    sub: 'only on counts that track best-before dates', prompt: 'Enter EXPIRY (YYYY-MM-DD)', ph: 'e.g. 2027-03-15' },
    comments: { what: 'Comments', sub: 'optional — turned on per count',           prompt: 'Comments (optional)', ph: 'Type a note or tap one below' },
  };
  // a question the gun knows and this page does not must never blank the screen
  const stepInfo = (k) => STEP_INFO[k] || { what: k, sub: '', prompt: String(k).toUpperCase(), ph: '' };
  let gunCfg = null;

  function renderStepOrder() {
    const box = $('stepOrder');
    box.innerHTML = '';
    gunCfg.order.forEach((key, i) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.step = key;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
      const mid = document.createElement('div');
      const w = document.createElement('div'); w.className = 'what'; w.textContent = stepInfo(key).what;
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = stepInfo(key).sub;
      mid.append(w, sub);
      const grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = '⋮⋮';
      li.append(n, mid, grip);
      li.addEventListener('dragstart', () => { li.classList.add('dragging'); });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); saveOrderFromDom(); });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        const dragging = box.querySelector('.dragging');
        if (!dragging || dragging === li) return;
        const r = li.getBoundingClientRect();
        box.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
      });
      box.appendChild(li);
    });
  }
  function saveOrderFromDom() {
    gunCfg.order = [...$('stepOrder').querySelectorAll('li')].map((li) => li.dataset.step);
    renderStepOrder();
    renderPreviewChoices();
    drawPreview();
  }

  function renderPreviewChoices() {
    const sel = $('fPreviewStep');
    const prior = sel.value;
    sel.innerHTML = '';
    for (const k of [...gunCfg.order, 'comments']) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `${stepInfo(k).what}${k === 'comments' ? '' : ` (step ${gunCfg.order.indexOf(k) + 1})`}`;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === prior)) sel.value = prior;
  }

  /** The gun's own markup and stylesheet, at the device's real pixel size. */
  function drawPreview() {
    const dev = DEVICES[gunCfg.device] || DEVICES.mc9090;
    const frame = $('gunFrame');
    frame.width = dev.w;
    frame.height = dev.h;
    $('deviceNote').textContent = `${dev.name} · ${dev.note}`;

    const step = $('fPreviewStep').value || gunCfg.order[0];
    const info = stepInfo(step);
    const idx = step === 'comments' ? gunCfg.order.length : gunCfg.order.indexOf(step);
    const total = gunCfg.order.length + 1;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const known = { pallet: 'PLT01001A', qty: '96', bin: 'F01A001' };
    const ctx = [];
    for (const k of gunCfg.order.slice(0, idx)) {
      if (k === 'pallet') {
        ctx.push(['Pallet', known.pallet]);
      }
      if (k === 'qty') ctx.push(['Qty', known.qty]);
      if (k === 'bin') ctx.push(['Bin', 'F01A001 — Level A · Position 001 · FRONT']);
    }

    const nextBin = gunCfg.showNextBin
      ? `<div class="nextbin"><span class="nb-lead">Next bin</span><b class="nb-code">F01A00${idx + 1}</b><span class="nb-prog">${idx} of 94</span></div>` : '';
    const chips = step === 'comments'
      ? `<div class="chips">${(promptState.comments || []).slice(0, 4).map((c) => `<button class="chip-btn">${esc(c)}</button>`).join('')}</div>` : '';
    // the countdown is part of what a counter sees, so the preview shows it too
    const secs = Number(promptState?.commentTimeout || 0);
    const moveOn = step === 'comments' && secs
      ? `<div class="moveon">Moving on to the next bin in ${secs}…</div>` : '';

    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/styles.css">
      <style>body{padding:8px;overflow:hidden}header{padding:6px 8px}.title{font-size:13px}</style>
      </head><body class="${gunCfg.textSize === 'large' ? 'big-text' : ''}">
      <header><span class="title">Team 1 · F01</span><span class="chip">0 queued</span></header>
      <div style="padding:8px">
        ${nextBin}
        <div class="step">Step ${idx + 1} of ${total}</div>
        <div class="prompt">${esc(info.prompt)}</div>
        <input class="big" placeholder="${esc(info.ph)}" value="">
        ${chips}
        ${moveOn}
        ${ctx.length ? `<div class="context">${ctx.map(([k, v]) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="ghost">Keyboard</button><button class="ghost">Back</button>${step === 'comments' ? '<button class="primary">Skip</button>' : ''}</div>
      </div></body></html>`;
  }

  function renderGun() {
    $('fTextSize').value = gunCfg.textSize;
    $('fShowNextBin').checked = gunCfg.showNextBin;
    $('fVibrate').checked = gunCfg.vibrate;
    $('fFullScreen').checked = gunCfg.fullScreen !== false;
    $('fKeepAwake').checked = gunCfg.keepAwake !== false;
    $('fPortrait').checked = gunCfg.portrait !== false;
    $('fAutoUpdate').checked = gunCfg.autoUpdate !== false;
    $('fConfirmOver').value = gunCfg.confirmOver;
    if (promptState) $('fCommentTimeout').value = promptState.commentTimeout;
    if (promptState) { $('fCommentsAsk').checked = promptState.commentsAsk !== false; $('fCommentsRequired').checked = promptState.commentsRequired === true; }
    $('fDevice').value = gunCfg.device;
    const chip = $('gunChip');
    chip.hidden = false;
    chip.className = 'chip' + (gunCfg.isDefault ? '' : ' online');
    chip.textContent = gunCfg.isDefault ? 'the defaults' : 'set for this site';
    renderStepOrder();
    renderPreviewChoices();
    drawPreview();
  }

  async function refreshGun() {
    gunCfg = await api.json('/api/admin/scanner-layout');
    renderGun();
  }

  /* Seconds, by a button rather than a number pad: this gets set in an office
     but it is read off a handheld, and one second either way is the whole
     difference between a counter finishing a note and being cut off. */
  const nudgeTimeout = (by) => {
    const el = $('fCommentTimeout');
    el.value = Math.max(0, Math.min(120, (Number(el.value) || 0) + by));
    el.dispatchEvent(new Event('change'));
  };
  $('btnCommentLess').onclick = () => nudgeTimeout(-1);
  $('btnCommentMore').onclick = () => nudgeTimeout(1);

  for (const id of ['fTextSize', 'fShowNextBin', 'fVibrate', 'fFullScreen', 'fKeepAwake', 'fPortrait', 'fAutoUpdate', 'fConfirmOver', 'fCommentTimeout', 'fDevice']) {
    $(id).addEventListener('change', () => {
      gunCfg.textSize = $('fTextSize').value;
      gunCfg.showNextBin = $('fShowNextBin').checked;
      gunCfg.vibrate = $('fVibrate').checked;
      gunCfg.fullScreen = $('fFullScreen').checked;
      gunCfg.keepAwake = $('fKeepAwake').checked;
      gunCfg.portrait = $('fPortrait').checked;
      gunCfg.autoUpdate = $('fAutoUpdate').checked;
      gunCfg.confirmOver = Number($('fConfirmOver').value) || 0;
      gunCfg.device = $('fDevice').value;
      if (promptState) promptState.commentTimeout = Math.max(0, Math.min(120, Number($('fCommentTimeout').value) || 0));
      drawPreview();
    });
  }
  $('fPreviewStep').addEventListener('change', drawPreview);

  $('btnSaveGun').onclick = async () => {
    try {
      const keep = gunCfg.defaults;
      const seconds = Math.max(0, Math.min(120, Number($('fCommentTimeout').value) || 0));
      /* The screen's layout and the time the comments step waits are stored in
         two places and set in one, because that is where somebody looks for
         them: both are saved by this button. */
      const [layout, prompts] = await Promise.all([
        api.post('/api/admin/scanner-layout', {
          order: gunCfg.order, textSize: gunCfg.textSize,
          showNextBin: gunCfg.showNextBin, confirmOver: gunCfg.confirmOver, vibrate: gunCfg.vibrate,
          fullScreen: gunCfg.fullScreen, keepAwake: gunCfg.keepAwake, portrait: gunCfg.portrait,
          autoUpdate: gunCfg.autoUpdate, device: gunCfg.device,
        }),
        api.post('/api/admin/scanner-prompts', { commentTimeout: seconds }),
      ]);
      gunCfg = layout;
      promptState = prompts;
      gunCfg.defaults = keep;
      renderGun();
      renderPrompts();
      msg($('gunMsg'), 'ok', 'Saved.',
        `Scanners will ask ${gunCfg.order.map((k) => stepInfo(k).what.toLowerCase()).join(' → ')}`
        + (seconds ? `, and the comments step moves on after ${seconds} second${seconds === 1 ? '' : 's'}` : ', and the comments step waits for the counter')
        + ' — within about half a minute, without signing out.');
    } catch (err) { msg($('gunMsg'), 'err', err.message); }
  };
  $('btnResetGun').onclick = () => {
    if (!confirm('Put the scanner screen back to the shipped defaults?')) return;
    gunCfg = { ...gunCfg, ...(gunCfg.defaults || {}) };
    if (promptState?.defaults) promptState.commentTimeout = promptState.defaults.commentTimeout;
    renderGun();
    msg($('gunMsg'), 'warn', 'Defaults loaded — press Save to keep them.');
  };

  /* ------------------------------------------------- what the scanners offer */
  let promptState = { comments: [], overrides: [], commentTimeout: 5, defaults: null };

  function renderPromptList(which, id) {
    const box = $(id);
    box.innerHTML = '';
    const items = promptState[which];
    if (!items.length) {
      const e = document.createElement('span');
      e.className = 'muted';
      e.textContent = 'none — counters will have to type it';
      box.appendChild(e);
      return;
    }
    for (const text of items) {
      const b = button(text, 'chip-btn remove', () => {
        promptState[which] = promptState[which].filter((x) => x !== text);
        renderPromptList(which, id);
      });
      b.title = 'Remove it';
      box.appendChild(b);
    }
  }
  const renderPrompts = () => {
    renderPromptList('comments', 'commentList');
    renderPromptList('overrides', 'overrideList');
    // the timer lives on the Scanners tab now, but it is the same setting
    if (promptState) $('fCommentTimeout').value = promptState.commentTimeout;
    const chip = $('promptChip');
    chip.hidden = false;
    chip.className = 'chip' + (promptState.isDefault ? '' : ' online');
    chip.textContent = promptState.isDefault ? 'the defaults' : 'set for this site';
  };

  /* which jobs the sign-on screen offers */
  const JOB_BOX = { full: 'fJobFull', cycle: 'fJobCycle', move: 'fJobMove', missing: 'fJobMissing' };
  const JOB_NAME = { full: 'full count', cycle: 'cycle count', move: 'Front2Back', missing: 'Not in Location' };
  function renderJobs(jobs) {
    for (const [k, id] of Object.entries(JOB_BOX)) $(id).checked = jobs[k] !== false;
    const on = Object.keys(JOB_BOX).filter((k) => jobs[k] !== false);
    $('jobsChip').hidden = false;
    $('jobsChip').textContent = on.length === 4 ? 'every job' : `only: ${on.map((k) => JOB_NAME[k]).join(', ')}`;
    $('jobsChip').className = 'chip ' + (on.length === 4 ? 'online' : 'warn');
  }
  async function refreshJobs() { renderJobs((await api.json('/api/admin/scanner-jobs')).jobs); }
  /* a job whose part of the app is off for the site is off the sign-on screen whatever is ticked */
  const JOB_FEATURE = { cycle: 'cycle', move: 'front', missing: 'missing' };
  function renderJobsNote(f) {
    const off = Object.entries(JOB_FEATURE).filter(([, feat]) => f[feat] === false).map(([k]) => k);
    for (const [k, id] of Object.entries(JOB_BOX)) {
      $(id).disabled = off.includes(k);
      $(id).closest('label').classList.toggle('off', off.includes(k));
    }
    $('jobsOffNote').hidden = !off.length;
    $('jobsOffNote').innerHTML = off.length
      ? `${off.map((k) => `<b>${JOB_NAME[k]}</b>`).join(', ')} ${off.length === 1 ? 'is' : 'are'} switched off for the whole site (Site &amp; systems → What is switched on), so the scanners do not offer ${off.length === 1 ? 'it' : 'them'} whatever is ticked here. The ticks are kept for when ${off.length === 1 ? 'it comes' : 'they come'} back.`
      : '';
  }

  /* ---------------------------------------------- what is switched on */
  let featureAll = [];
  function renderFeatures(data) {
    featureAll = data.all || featureAll;
    const f = data.features || {};
    $('featuresList').replaceChildren(...featureAll.map(([k, label, what]) => {
      const l = document.createElement('label');
      l.className = 'cb' + (f[k] === false ? ' off' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'fFeature-' + k;
      box.dataset.feature = k;
      box.checked = f[k] !== false;
      box.onchange = () => l.classList.toggle('off', !box.checked);
      const text = document.createElement('span');
      text.append(document.createTextNode(label));
      const w = document.createElement('span');
      w.className = 'what';
      w.textContent = what;
      text.appendChild(w);
      l.append(box, text);
      return l;
    }));
    const off = featureAll.filter(([k]) => f[k] === false).map(([, l]) => l);
    $('featuresChip').hidden = false;
    $('featuresChip').textContent = off.length ? `off: ${off.join(', ')}` : 'everything on';
    $('featuresChip').className = 'chip ' + (off.length ? 'warn' : 'online');
    if (api.setFeatures) api.setFeatures(f);       // the sidebar follows at once
    renderJobsNote(f);
  }
  async function refreshFeatures() {
    if (!api.me || api.me.role !== 'admin') { $('featuresCard').hidden = true; return; }
    $('featuresCard').hidden = false;
    renderFeatures(await api.json('/api/admin/features'));
  }
  async function saveFeatures(body, okText) {
    try {
      const out = await api.post('/api/admin/features', body);
      renderFeatures(out);
      const off = featureAll.filter(([k]) => out.features[k] === false).map(([, l]) => l);
      msg($('featuresMsg'), 'ok', okText || (off.length ? `Saved: ${off.join(', ')} switched off.` : 'Saved: everything is on.'),
        off.length ? 'Gone from the sidebar, the dashboard tabs, the search box and the scanners for everyone, until ticked again.' : 'Every page and job shows again.');
    } catch (err) { msg($('featuresMsg'), 'err', 'Not saved', err.message); }
  }
  $('btnFeaturesSave').onclick = () => saveFeatures(Object.fromEntries([...document.querySelectorAll('#featuresList input[data-feature]')].map((b) => [b.dataset.feature, b.checked])));
  $('btnFeaturesCountOnly').onclick = () => saveFeatures({ preset: 'count-only' }, 'Saved: the full count and its second counts, with nothing else to wander into.');
  $('btnFeaturesAll').onclick = () => saveFeatures({ preset: 'everything' });
  $('btnJobsSave').onclick = async () => {
    try {
      const body = {};
      for (const [k, id] of Object.entries(JOB_BOX)) body[k] = $(id).checked;
      const out = await api.post('/api/admin/scanner-jobs', body);
      renderJobs(out.jobs);
      const on = Object.keys(JOB_BOX).filter((k) => out.jobs[k]);
      msg($('jobsMsg'), 'ok', on.length === 4 ? 'The scanners offer every job.' : `The scanners offer ${on.map((k) => JOB_NAME[k]).join(' and ')} now.`, 'Each scanner picks it up the next time it is online.');
    } catch (err) { msg($('jobsMsg'), 'err', 'Not saved', err.message); }
  };
  let promptDefaults = null;
  async function refreshPrompts() {
    promptState = await api.json('/api/admin/scanner-prompts');
    promptDefaults = promptState.defaults || promptDefaults;
    $('fCommentsAsk').checked = promptState.commentsAsk !== false;
    $('fCommentsRequired').checked = promptState.commentsRequired === true;
    renderPrompts();
  }
  /* one Save for the whole section: the jobs, the reasons and the SOS list each
     go to their own setting, and the message at the bottom sums it up */
  $('btnSaveOffers').onclick = async () => {
    clearMsg($('offersMsg'));
    $('btnJobsSave').click();
    $('btnSavePrompts').click();
    $('btnSaveSos').click();
    if (!$('btnSaveIssues').hidden) $('btnSaveIssues').click();
    await new Promise((r) => setTimeout(r, 900));
    const bad = ['jobsMsg', 'promptMsg', 'sosMsg', 'issueMenuMsg'].filter((id) => $(id).classList.contains('err'));
    // one summary at the bottom; a part keeps its own message only when it refused
    for (const id of ['jobsMsg', 'promptMsg', 'sosMsg', 'issueMenuMsg']) if (!bad.includes(id)) clearMsg($(id));
    if (bad.length) msg($('offersMsg'), 'err', 'Not everything saved', 'See the message under the part that refused.');
    else msg($('offersMsg'), 'ok', 'Saved: the jobs, the comments, the override reasons, the SOS list and Report a problem.', 'Scanners pick the reasons up within about half a minute, between pallets; the jobs the next time they are online.');
  };
  $('btnSaveIdle').onclick = async () => {
    try {
      const idle = await api.post('/api/admin/idle-config', { minutes: Number($('fIdleMinutes').value) || 0, teams: $('fIdleTeams').checked });
      $('fIdleMinutes').value = idle.minutes;
      msg($('idleMsg'), 'ok', 'Saved.', idle.minutes ? `A quiet team shows after ${idle.minutes} minutes.` : 'The stopped-scanning alert is off.');
    } catch (err) { msg($('idleMsg'), 'err', err.message); }
  };

  const addPrompt = (which, inputId, listId) => {
    const v = $(inputId).value.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!v) return;
    if (promptState[which].some((x) => x.toLowerCase() === v.toLowerCase())) {
      msg($('promptMsg'), 'warn', `"${v}" is already there`);
      return;
    }
    promptState[which] = [...promptState[which], v];
    $(inputId).value = '';
    clearMsg($('promptMsg'));
    renderPromptList(which, listId);
  };
  $('btnAddComment').onclick = () => addPrompt('comments', 'fNewComment', 'commentList');
  $('btnAddOverride').onclick = () => addPrompt('overrides', 'fNewOverride', 'overrideList');
  $('fNewComment').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddComment').click(); });
  $('fNewOverride').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddOverride').click(); });

  $('btnSavePrompts').onclick = async () => {
    try {
      promptState = await api.post('/api/admin/scanner-prompts', {
        comments: promptState.comments,
        overrides: promptState.overrides,
        commentsAsk: $('fCommentsAsk').checked,
        commentsRequired: $('fCommentsRequired').checked,
        commentTimeout: Math.max(0, Math.min(120, Number($('fCommentTimeout').value) || 0)),
      });
      promptState.defaults = promptState.defaults || null;
      renderPrompts();
      msg($('promptMsg'), 'ok', 'Saved.', 'Scanners pick this up within about half a minute.');
    } catch (err) { msg($('promptMsg'), 'err', err.message); }
  };
  $('btnResetPrompts').onclick = async () => {
    if (!confirm('Put the comment and override reasons back to the shipped defaults?')) return;
    const d = promptState.defaults || promptDefaults || { comments: [], overrides: [] };
    promptState = { ...promptState, ...d };
    renderPrompts();
    msg($('promptMsg'), 'warn', 'Defaults loaded — press Save to keep them.');
  };

  /* ------------------------------------------------- adjustment reasons
     The reason codes an approval carries. A site setting rather than a per-count
     one: a warehouse's vocabulary does not change between Tuesday's cycle
     count and the wall-to-wall in March. */
  let reasonState = { reasons: [], isDefault: true };

  function renderReasons() {
    const box = $('reasonList');
    box.innerHTML = '';
    if (!reasonState.reasons.length) {
      const e = document.createElement('span');
      e.className = 'muted';
      e.textContent = 'none — the shipped list is used instead';
      box.appendChild(e);
    }
    for (const text of reasonState.reasons) {
      const b = button(text, 'chip-btn remove', () => {
        reasonState.reasons = reasonState.reasons.filter((x) => x !== text);
        renderReasons();
      });
      b.title = 'Remove it';
      box.appendChild(b);
    }
    const chip = $('reasonChip');
    chip.hidden = false;
    chip.className = 'chip' + (reasonState.isDefault ? '' : ' online');
    chip.textContent = reasonState.isDefault ? 'the defaults' : 'set for this site';
  }

  async function refreshReasons() {
    reasonState = await api.json('/api/admin/adjustment-reasons');
    renderReasons();
  }

  $('btnAddReason').onclick = () => {
    const v = $('fNewReason').value.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!v) return;
    if (reasonState.reasons.some((x) => x.toLowerCase() === v.toLowerCase())) {
      msg($('reasonMsg'), 'warn', `"${v}" is already there`);
      return;
    }
    reasonState.reasons = [...reasonState.reasons, v];
    $('fNewReason').value = '';
    clearMsg($('reasonMsg'));
    renderReasons();
  };
  $('fNewReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddReason').click(); });

  $('btnSaveReasons').onclick = async () => {
    try {
      reasonState = await api.post('/api/admin/adjustment-reasons', { reasons: reasonState.reasons });
      renderReasons();
      msg($('reasonMsg'), 'ok', 'Saved.', 'The dashboard picks these up on its next refresh.');
    } catch (err) { msg($('reasonMsg'), 'err', err.message); }
  };
  $('btnResetReasons').onclick = async () => {
    if (!confirm('Put the adjustment reasons back to the shipped defaults?')) return;
    try {
      reasonState = await api.post('/api/admin/adjustment-reasons', { reasons: [] });
      renderReasons();
      msg($('reasonMsg'), 'warn', 'Back to the defaults.');
    } catch (err) { msg($('reasonMsg'), 'err', err.message); }
  };

  /* ------------------------------------------------------------ scanners */
  const deviceUrl = (uid) => `${location.origin}/?d=${uid}`;

  async function refreshDevices() {
    const data = await api.json('/api/admin/devices');
    $('authChip').hidden = false;
    $('authChip').textContent = data.authRequired ? 'scanners must sign in' : 'scanner sign-in OFF';
    $('authChip').className = 'chip ' + (data.authRequired ? 'online' : 'offline');
    /* TEST: scanners are LIVE's. No adding, no new links, no setup cards here - just the guns that came over. */
    const home = data.home;
    for (const el of [$('devAddRow'), $('devHowTo')]) if (el) el.hidden = !!home;
    let note = $('devLinkedNote');
    if (home && !note) {
      note = document.createElement('div');
      note.id = 'devLinkedNote';
      note.className = 'feedback show';
      $('devicesCard').querySelector('h2').insertAdjacentElement('afterend', note);
    }
    if (note) {
      note.hidden = !home;
      if (home) {
        note.innerHTML = '<b></b> <span></span> <a target="_top"></a>';
        note.querySelector('b').textContent = `Scanners are registered on ${home.name}.`;
        note.querySelector('span').textContent = `A gun comes to ${home.self} when someone taps ${home.self} on its sign-on screen, under the same name and link — so nothing is added, reset or printed here. Do that on ${home.name}, and choose ${home.self} under On the scanners on its Systems card.`;
        const a = note.querySelector('a');
        a.href = `${home.url}/settings#gun`; a.textContent = `${home.name} → Settings → Scanners`;
      }
    }
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
        if (!home) tdBtns.append(copy, qr);
        tr.appendChild(tdBtns);
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
        if (!home) tdDel.appendChild(reset);
        tdDel.appendChild(button('Remove', 'sm danger', async () => {
          if (!confirm(home ? `Remove ${d.name} from ${home.self}? It comes back the next time it switches here from ${home.name}.` : `Remove ${d.name}? Its link will stop working on the device.`)) return;
          try { await api.call(`/api/admin/devices/${d.uid}`, { method: 'DELETE' }); await refreshDevices(); }
          catch (err) { msg($('deviceMsg'), 'err', err.message); }
        }));
        tr.appendChild(tdDel);
        return tr;
      }, home ? `No scanner has switched to ${home.self} yet.` : 'No scanners registered yet.');
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
  };

  /* Each list gets its own card: they are different jobs, done at different
     times, by people who should not have to know which one a dropdown is on. */
  function renderGuide(kind) {
    const g = FILE_GUIDE[kind];
    const box = $('colGuide-' + kind);
    box.innerHTML = '';
    const head = document.createElement('div');
    head.innerHTML = '<b>Columns</b> — matched by name, any order, extra columns ignored. &nbsp; <a></a>';
    const a = head.querySelector('a');
    a.href = '/templates/' + g.file;
    a.download = g.file;
    a.textContent = '⬇ Download a sample ' + g.file;
    box.appendChild(head);
    const cols = document.createElement('div');
    cols.className = 'cols';
    for (const [name, why] of g.required) { const c = document.createElement('code'); c.className = 'req'; c.textContent = name + ' (required)'; c.title = why; cols.appendChild(c); }
    for (const [name, why] of g.optional) { const c = document.createElement('code'); c.textContent = name; c.title = why || 'optional'; cols.appendChild(c); }
    box.appendChild(cols);
    const list = document.createElement('div');
    list.className = 'note';
    list.innerHTML = [...g.required, ...g.optional].filter(([, why]) => why).map(([n, why]) => `<b>${n}</b>: ${why}`).join(' · ');
    box.appendChild(list);
  }

  async function uploadText(kind, text, label) {
    const out = $('uploadMsg-' + kind);
    if (!needSession(out)) return;
    msg(out, 'warn', `Uploading ${label}…`);
    try {
      const src = kind === 'pallets' ? ($('fSource-pallets').value || '').trim() : '';
      const stats = await api.json(`/api/admin/sessions/${sessionId}/master?kind=${kind}&replace=${$('fReplace-' + kind).checked ? 1 : 0}${src ? `&source=${encodeURIComponent(src)}` : ''}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text });
      if (kind === 'pallets') refreshSources().catch(() => {});
      const t = stats.totals;
      msg(out, 'ok', `Imported ${stats.rows.toLocaleString()} rows from ${label}`,
        `This count now has ${t.bins.toLocaleString()} bins in ${t.aisles} aisles, ${t.pallets.toLocaleString()} pallets, ${t.assignments} planned aisle assignments` +
        (stats.skipped ? ` · ${stats.skipped} row(s) skipped (${stats.skippedNoLevels ? stats.skippedNoLevels + ' with no levels; ' : ''}missing required column, or unknown aisle)` : '') +
        (stats.excluded ? ` · ${stats.excluded} bins left out (counted manually: ${stats.excludedGroups.join(', ')})` : '') +
        (stats.openBins ? ` · ${stats.openBins.toLocaleString()} rows were empty positions (OPEN), expected to be found empty` : '') +
        (stats.merged ? ` · ${stats.merged} container${stats.merged === 1 ? '' : 's'} listed twice in the same bin — the quantities were added up` : '') +
        (stats.duplicates ? ` · ${stats.duplicates} container${stats.duplicates === 1 ? '' : 's'} listed in two different bins — the first row stands: ${stats.duplicateList.slice(0, 5).join('; ')}${stats.duplicates > 5 ? ' …' : ''}` : '') +
        (stats.nonPositive ? ` · ${stats.nonPositive} row${stats.nonPositive === 1 ? '' : 's'} with a zero or negative quantity, kept as the report says` : '') +
        (stats.bySource ? ` · systems: ${Object.entries(stats.bySource).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}` : ''));
      await refreshAisles();
      await refreshSetup().catch(() => {});
    } catch (err) { msg(out, 'err', 'Upload failed', err.message); }
  }

  /* the lists back out as files; the override box only for the site admin */
  $('btnDownload-bins').onclick = () => { if (needSession($('uploadMsg-bins'))) api.download(`/api/admin/sessions/${sessionId}/export/bins.csv`, `bins-${sessionId}.csv`); };
  $('btnDownload-pallets').onclick = () => { if (needSession($('uploadMsg-pallets'))) api.download(`/api/admin/sessions/${sessionId}/export/master.csv`, `inventory-report-${sessionId}.csv`); };
  function drawOverride() {
    const site = !!(api.me && api.me.siteAdmin);
    $('overrideBox').hidden = !site;
    if (!site) $('fReplace-pallets').checked = false;
  }

  for (const kind of Object.keys(FILE_GUIDE)) {
    if (!$('btnUpload-' + kind)) continue;
    renderGuide(kind);
    $('btnUpload-' + kind).onclick = async () => {
      const file = $('fFile-' + kind).files[0];
      if (!file) return msg($('uploadMsg-' + kind), 'err', 'Choose a file first');
      if (!needSession($('uploadMsg-' + kind))) return;
      msg($('uploadMsg-' + kind), 'warn', `Reading ${file.name}…`);
      try {
        await uploadText(kind, await fileToCsv(file), file.name);
        $('fFile-' + kind).value = '';
      } catch (err) { msg($('uploadMsg-' + kind), 'err', 'Upload failed', err.message); }
    };
  }

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
      const r = await api.json(`/api/admin/sessions/${sessionId}/erp/${$('fErpFormat').value}/preview${erpSourceQuery()}`);
      msg($('erpMsg'), r.held ? 'warn' : 'ok', `${r.rows.toLocaleString()} rows — ${r.format.label}`,
        r.held
          ? `${r.held.toLocaleString()} adjustment${r.held === 1 ? '' : 's'} left out — still waiting for approval on the dashboard. First few lines below.`
          : 'First few lines below. Nothing has been sent anywhere.');
      $('erpSample').style.display = 'block';
      $('erpSample').textContent = r.sample;
    } catch (err) { msg($('erpMsg'), 'err', err.message); }
  };
  $('btnErpDownload').onclick = () => {
    if (!needSession($('erpMsg'))) return;
    api.download(`/api/admin/sessions/${sessionId}/erp/${$('fErpFormat').value}.csv${erpSourceQuery()}`, `${$('fErpFormat').value}${$('fErpSource').value && $('fErpSource').value !== '~none' ? '-' + $('fErpSource').value.replace(/[^A-Za-z0-9]+/g, '-') : ''}-${sessionId}.csv`)
      .catch((err) => msg($('erpMsg'), 'err', err.message));
  };

  /* ------------------------------------------- SOS: the list, and the channel
     What a counter can raise from the gun, in the site's own words, and the
     Teams channel the office already watches. The webhook address is a key -
     anybody holding it can post into that channel - so it is written once and
     only ever shown back masked. */
  let sosState = { reasons: [], isDefault: true, defaults: [] };
  let teamsState = { on: false, configured: false, masked: '', tellWhenClosed: true };

  function renderSos() {
    const box = $('sosList');
    box.innerHTML = '';
    if (!sosState.reasons.length) {
      const e = document.createElement('span');
      e.className = 'muted';
      e.textContent = 'none — the shipped list is used instead';
      box.appendChild(e);
    }
    for (const text of sosState.reasons) {
      const b = button(text, 'chip-btn remove', () => {
        sosState.reasons = sosState.reasons.filter((x) => x !== text);
        renderSos();
      });
      b.title = 'Remove it';
      box.appendChild(b);
    }
    const chip = $('sosChip');
    chip.hidden = false;
    chip.className = 'chip' + (sosState.isDefault ? '' : ' online');
    chip.textContent = sosState.isDefault ? 'the shipped list' : 'set for this site';
    $('fTeamsOn').checked = teamsState.on;
    $('fTeamsClosed').checked = teamsState.tellWhenClosed !== false;
    $('teamsWho').textContent = teamsState.configured
      ? `Posting to ${teamsState.masked}`
      : 'No Teams channel set — alerts stay on the dashboard.';
  }

  /* ------------------------------------------------- Report a problem
     The kinds of problem the gun offers, each with its reasons and what the
     counter must scan to confirm it: the bin, the pallet, either, or nothing. */
  let issueState = { menu: [], isDefault: true, defaults: [] };
  const ISSUE_CONFIRM = [['bin', 'Scan the bin to confirm'], ['pallet', 'Scan the pallet to confirm'], ['either', 'Scan the pallet or the bin'], ['none', 'No scan needed']];
  const ISSUE_ABOUT = [['pallet', 'a pallet'], ['rack', 'racking or a bin'], ['product', 'product'], ['bin', 'a blocked bin'], ['', 'something else']];
  const kindOf = (target) => (target === 'bin' ? 'blocked' : target ? 'damage' : 'other');
  function issueDirty() { $('btnSaveIssues').hidden = false; }
  function renderIssueMenu() {
    const box = $('issueList');
    box.innerHTML = '';
    issueState.menu.forEach((k, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'ikind';
      wrap.dataset.i = i;
      const head = document.createElement('div');
      head.className = 'ihead';
      const name = Object.assign(document.createElement('input'), { value: k.label, maxLength: 40, className: 'sm iname' });
      name.setAttribute('aria-label', 'Name on the gun');
      name.oninput = () => { k.label = name.value; issueDirty(); };
      const about = document.createElement('select');
      about.className = 'sm iabout';
      about.title = 'What it is about — sorts it on the fix list';
      for (const [v, l] of ISSUE_ABOUT) about.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: `About ${l}` }));
      about.value = k.target || '';
      about.onchange = () => { k.target = about.value; k.kind = kindOf(about.value); issueDirty(); };
      const conf = document.createElement('select');
      conf.className = 'sm iconfirm';
      for (const [v, l] of ISSUE_CONFIRM) conf.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: l }));
      conf.value = k.confirm || 'none';
      conf.onchange = () => { k.confirm = conf.value; issueDirty(); };
      const up = button('↑', 'sm', () => { if (i > 0) { issueState.menu.splice(i - 1, 0, issueState.menu.splice(i, 1)[0]); issueDirty(); renderIssueMenu(); } });
      up.title = 'Move it up the list on the gun';
      up.disabled = i === 0;
      const del = button('Remove', 'sm danger', () => { issueState.menu.splice(i, 1); issueDirty(); renderIssueMenu(); });
      head.append(name, about, conf, up, del);
      const rs = document.createElement('div');
      rs.className = 'ireasons';
      for (const r of k.reasons) {
        const b = button(r, 'chip-btn remove', () => { k.reasons = k.reasons.filter((x) => x !== r); issueDirty(); renderIssueMenu(); });
        b.title = 'Remove this reason';
        rs.appendChild(b);
      }
      const add = Object.assign(document.createElement('input'), { className: 'sm inew', maxLength: 60, placeholder: 'Add a reason, then Enter' });
      add.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const v = add.value.replace(/\s+/g, ' ').trim();
        if (!v || k.reasons.some((x) => x.toLowerCase() === v.toLowerCase())) { add.value = ''; return; }
        k.reasons = [...k.reasons, v];
        issueDirty(); renderIssueMenu();
        const again = $('issueList').querySelector(`.ikind[data-i="${i}"] .inew`);
        if (again) again.focus();
      };
      rs.appendChild(add);
      wrap.append(head, rs);
      box.appendChild(wrap);
    });
    const chip = $('issueChip');
    chip.hidden = false;
    chip.className = 'chip' + (issueState.isDefault ? '' : ' online');
    chip.textContent = issueState.isDefault ? 'the shipped list' : 'set for this site';
  }
  async function refreshIssueMenu() {
    issueState = await api.json('/api/admin/issue-menu');
    issueState.menu = issueState.menu.map((k) => ({ ...k, reasons: [...k.reasons] }));
    $('btnSaveIssues').hidden = true;
    renderIssueMenu();
  }
  $('btnAddIssue').onclick = () => {
    const v = $('fNewIssue').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!v) return;
    if (issueState.menu.some((k) => k.label.toLowerCase() === v.toLowerCase())) { msg($('issueMenuMsg'), 'warn', `"${v}" is already there`); return; }
    issueState.menu.push({ kind: 'other', target: '', label: v, confirm: 'bin', reasons: [] });
    $('fNewIssue').value = '';
    clearMsg($('issueMenuMsg'));
    issueDirty();
    renderIssueMenu();
    const last = $('issueList').querySelector('.ikind:last-child .inew');
    if (last) last.focus();
  };
  $('fNewIssue').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddIssue').click(); });
  $('btnSaveIssues').onclick = async () => {
    try {
      const empty = issueState.menu.find((k) => !k.reasons.length);
      if (empty) { msg($('issueMenuMsg'), 'err', `"${empty.label || 'A new kind'}" needs at least one reason`, 'Type a reason in its box and press Enter, or remove it.'); return; }
      if (!issueState.menu.length) { msg($('issueMenuMsg'), 'err', 'Keep at least one kind of problem', 'Or press Restore the shipped list.'); return; }
      issueState = await api.post('/api/admin/issue-menu', { menu: issueState.menu });
      issueState.menu = issueState.menu.map((k) => ({ ...k, reasons: [...k.reasons] }));
      $('btnSaveIssues').hidden = true;
      renderIssueMenu();
      msg($('issueMenuMsg'), 'ok', 'Saved.', 'A gun picks the list up the next time Report a problem is opened with signal.');
    } catch (err) { msg($('issueMenuMsg'), 'err', err.message); }
  };
  $('btnResetIssues').onclick = async () => {
    if (!confirm('Put Report a problem back to the shipped list?')) return;
    try {
      issueState = await api.post('/api/admin/issue-menu', { menu: [] });
      issueState.menu = issueState.menu.map((k) => ({ ...k, reasons: [...k.reasons] }));
      $('btnSaveIssues').hidden = true;
      renderIssueMenu();
      msg($('issueMenuMsg'), 'ok', 'Back to the shipped list.');
    } catch (err) { msg($('issueMenuMsg'), 'err', err.message); }
  };

  async function refreshSosSettings() {
    const [reasons, teams, idle] = await Promise.all([
      api.json('/api/admin/sos-reasons'),
      api.json('/api/admin/teams-webhook'),
      api.json('/api/admin/idle-config'),
    ]);
    sosState = reasons;
    teamsState = teams;
    $('fIdleMinutes').value = idle.minutes;
    $('fIdleTeams').checked = idle.teams;
    renderSos();
  }

  $('btnAddSos').onclick = () => {
    const v = $('fNewSos').value.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!v) return;
    if (sosState.reasons.some((x) => x.toLowerCase() === v.toLowerCase())) {
      msg($('sosMsg'), 'warn', `"${v}" is already there`);
      return;
    }
    sosState.reasons = [...sosState.reasons, v];
    $('fNewSos').value = '';
    clearMsg($('sosMsg'));
    renderSos();
  };
  $('fNewSos').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddSos').click(); });

  $('btnSaveSos').onclick = async () => {
    try {
      sosState = await api.post('/api/admin/sos-reasons', { reasons: sosState.reasons });
      const idle = await api.post('/api/admin/idle-config', {
        minutes: Number($('fIdleMinutes').value) || 0, teams: $('fIdleTeams').checked,
      });
      $('fIdleMinutes').value = idle.minutes;
      renderSos();
      msg($('sosMsg'), 'ok', 'Saved.', 'Scanners pick the list up within about half a minute.');
    } catch (err) { msg($('sosMsg'), 'err', err.message); }
  };

  /* The Teams channel is its own card under Integrations: set once, left alone. */
  $('btnSaveTeams').onclick = async () => {
    try {
      /* An empty box means "leave the address alone" - the page only ever has
         the masked one - so typing nothing cannot wipe a working channel. */
      teamsState = await api.post('/api/admin/teams-webhook', {
        url: $('fTeamsUrl').value.trim() || undefined,
        on: $('fTeamsOn').checked,
        tellWhenClosed: $('fTeamsClosed').checked,
      });
      $('fTeamsUrl').value = '';
      renderSos();
      msg($('teamsMsg'), 'ok', 'Saved.', teamsState.configured ? `Alerts ${teamsState.on ? 'go' : 'would go'} to ${teamsState.masked}.` : 'No channel address yet.');
    } catch (err) { msg($('teamsMsg'), 'err', err.message); }
  };

  $('btnTestTeams').onclick = async () => {
    try {
      msg($('teamsMsg'), 'warn', 'Sending a test card…');
      const out = await api.post('/api/admin/teams-webhook/test', {});
      if (out.sent) msg($('teamsMsg'), 'ok', 'Teams took it.', 'Check the channel — a test card should be in it.');
      else msg($('teamsMsg'), 'err', 'Teams did not take it', out.why);
    } catch (err) { msg($('teamsMsg'), 'err', err.message); }
  };

  /* ------------------------------------------------- the pallet system's address */
  async function refreshPalletSystem() {
    const ps = await api.json('/api/admin/pallet-system');
    $('fPalletSystemUrl').value = ps.url || '';
    $(ps.mode === 'window' ? 'fPsWindow' : ps.mode === 'proxy' ? 'fPsProxy' : 'fPsFrame').checked = true;
  }
  const psMode = () => ($('fPsWindow').checked ? 'window' : $('fPsProxy').checked ? 'proxy' : 'frame');
  $('btnPalletSystemSave').onclick = async () => {
    try {
      const r = await api.post('/api/admin/pallet-system', { url: $('fPalletSystemUrl').value, mode: psMode() });
      msg($('palletSystemMsg'), 'ok', r.url ? 'Saved.' : 'Cleared.', !r.url ? 'The desks show the strip alone.' : r.mode === 'window' ? 'The desks and the scanners open it in its own window now.' : r.mode === 'proxy' ? 'The desks and the scanners show it through this app now, framed under the strip.' : 'The desks and the scanners frame it now.');
    } catch (err) { msg($('palletSystemMsg'), 'err', err.message); }
  };
  /* What the system's own headers say: whether a frame will show it, and
     whether a sign-in made in a frame would stick. Read from the server, which
     may not reach a system on the warehouse's own network. */
  $('btnPalletSystemCheck').onclick = async () => {
    const url = $('fPalletSystemUrl').value.trim();
    if (!url) return msg($('palletSystemCheck'), 'err', 'Type the address first.');
    msg($('palletSystemCheck'), 'warn', 'Asking the system…');
    try {
      const r = await api.post('/api/admin/pallet-system/check', { url });
      const kind = r.verdict === 'frame' ? 'ok' : r.verdict === 'unreachable' ? 'warn' : 'warn';
      const head = r.verdict === 'frame' ? 'It can be framed under the desk as it is.' : r.verdict === 'unreachable' ? 'Could not be checked from the server - a plain frame or its own window are the choices.' : 'Show it through this app: framed under the desk, with its sign-in working.';
      msg($('palletSystemCheck'), kind, head, r.findings.join(' '));
      if (r.verdict === 'proxy') $('fPsProxy').checked = true;
      if (r.verdict === 'unreachable' && $('fPsProxy').checked) $('fPsWindow').checked = true;
    } catch (err) { msg($('palletSystemCheck'), 'err', err.message); }
  };

  /* ------------------------------------------------------------- the logo
     Read in the browser, shrunk to a header-sized PNG if it is a big photo of
     one, and kept on the server as a data URL. */
  function renderLogo(b) {
    const frame = $('logoFrame');
    frame.innerHTML = '';
    if (b && b.logo) {
      const img = document.createElement('img');
      img.src = b.logo; img.alt = 'The site logo';
      frame.appendChild(img);
    } else {
      const none = document.createElement('span'); none.className = 'none'; none.textContent = 'No logo yet — the ▦ mark is shown.';
      frame.appendChild(none);
    }
    $('btnLogoRemove').hidden = !(b && b.logo);
    $('fLogoOnGuns').checked = b && b.logo ? b.onGuns !== false : true;
  }
  async function refreshLogo() {
    const b = await api.json('/api/admin/logo');
    renderLogo(b);
    if (document.activeElement !== $('fSiteName') && document.activeElement !== $('fSitePlace')) { $('fSiteName').value = b.name || ''; $('fSitePlace').value = b.place || ''; }
  }
  /* ------------------------------------------------------------ the crew board */
  function drawCrewBoard(c) {
    $('fCbShift').value = c.shift || 'auto';
    $('fCbScroll').checked = !!c.scroll.on;
    $('fCbSpeed').value = ['slow', 'normal', 'fast'].includes(c.scroll.speed) ? c.scroll.speed : 'normal';
    $('fCbPause').value = c.scroll.pause;
    $('fCbMembers').checked = c.show.members; $('fCbOpen').checked = c.show.openSeats; $('fCbNotes').checked = c.show.notes;
    $('fCbWhere').checked = c.show.where; $('fCbLast').checked = c.show.lastScan; $('fCbCount').checked = c.show.count;
    $('fCbS1From').value = c.shifts['1'].from; $('fCbS1To').value = c.shifts['1'].to;
    $('fCbS2From').value = c.shifts['2'].from; $('fCbS2To').value = c.shifts['2'].to;
    $('cbShiftHours').textContent = (c.shiftHours || []).map((s) => `${s.label} ${s.hours}`).join(' · ');
  }
  async function refreshCrewBoard() {
    if (!api.me || api.me.role !== 'admin') { $('crewBoardCard').hidden = true; return; }
    $('crewBoardCard').hidden = false;
    drawCrewBoard(await api.json('/api/admin/crew-board'));
  }
  $('btnCrewBoardSave').onclick = async () => {
    try {
      const c = await api.post('/api/admin/crew-board', {
        shift: $('fCbShift').value,
        scroll: { on: $('fCbScroll').checked, speed: $('fCbSpeed').value, pause: Number($('fCbPause').value) || 0 },
        show: { members: $('fCbMembers').checked, openSeats: $('fCbOpen').checked, notes: $('fCbNotes').checked, where: $('fCbWhere').checked, lastScan: $('fCbLast').checked, count: $('fCbCount').checked },
        shifts: { 1: { from: $('fCbS1From').value, to: $('fCbS1To').value }, 2: { from: $('fCbS2From').value, to: $('fCbS2To').value } },
      });
      drawCrewBoard(c);
      const hours = (c.shiftHours || []).map((s) => `${s.label} ${s.hours}`).join(', ');
      msg($('crewBoardMsg'), 'ok', 'Saved.', `The screen shows ${c.shift === 'auto' ? 'the shift on now by the clock' : c.shift === '1' ? 'the 1st shift' : 'the 2nd shift'}${c.scroll.on ? `, scrolling ${c.scroll.speed}` : ', without scrolling'}; the shifts are ${hours}. It picks a change up within half a minute.`);
    } catch (err) { msg($('crewBoardMsg'), 'err', err.message); }
  };
  $('btnSiteNameSave').onclick = async () => {
    try {
      const b = await api.post('/api/admin/site-name', { name: $('fSiteName').value, place: $('fSitePlace').value });
      $('fSiteName').value = b.name; $('fSitePlace').value = b.place;
      await api.refreshBranding();
      msg($('siteNameMsg'), 'ok', `The site is now “${b.name}”${b.place ? ' · ' + b.place : ''}.`, 'Every page shows it now; the scanners and the board pick it up on their next refresh.');
    } catch (err) { msg($('siteNameMsg'), 'err', 'Not saved', err.message); }
  };
  const readLogo = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('could not read the file'));
    r.readAsDataURL(file);
  });
  /* Anything but an SVG goes through a canvas: 400 px across is more than a
     56 px header needs, and keeps a phone photo of a sign out of every gun. */
  async function shrinkLogo(dataUrl, type) {
    if (type === 'image/svg+xml' || dataUrl.length < 120_000) return dataUrl;
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('that image would not open')); i.src = dataUrl; });
    const scale = Math.min(1, 400 / img.naturalWidth, 160 / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
  $('btnLogoUpload').onclick = async () => {
    const file = $('fLogo').files[0];
    if (!file) return msg($('logoMsg'), 'err', 'Choose an image first');
    try {
      msg($('logoMsg'), 'warn', 'Uploading…');
      const dataUrl = await shrinkLogo(await readLogo(file), file.type);
      const b = await api.post('/api/admin/logo', { dataUrl, onGuns: $('fLogoOnGuns').checked });
      renderLogo(b);
      $('fLogo').value = '';
      if (api.refreshBranding) api.refreshBranding();
      msg($('logoMsg'), 'ok', 'Logo saved.', b.onGuns ? 'It is in the sidebar now, and on the scanners the next time they are online.' : 'It is in the sidebar now.');
    } catch (err) { msg($('logoMsg'), 'err', 'Not saved', err.message); }
  };
  $('fLogoOnGuns').onchange = async () => {
    if ($('btnLogoRemove').hidden) return;          // no logo yet: the box just rides along with the upload
    try {
      const b = await api.post('/api/admin/logo', { onGuns: $('fLogoOnGuns').checked });
      renderLogo(b);
      msg($('logoMsg'), 'ok', b.onGuns ? 'The scanners will show it.' : 'The scanners will not show it.');
    } catch (err) { msg($('logoMsg'), 'err', err.message); }
  };
  $('btnLogoRemove').onclick = async () => {
    if (!confirm('Remove the logo?')) return;
    try {
      renderLogo(await api.json('/api/admin/logo', { method: 'DELETE' }));
      if (api.refreshBranding) api.refreshBranding();
      msg($('logoMsg'), 'warn', 'Logo removed.');
    } catch (err) { msg($('logoMsg'), 'err', err.message); }
  };

  $('btnResetSos').onclick = async () => {
    if (!confirm('Put the SOS list back to the shipped one?')) return;
    try {
      sosState = await api.post('/api/admin/sos-reasons', { reasons: [] });
      renderSos();
      msg($('sosMsg'), 'warn', 'Back to the shipped list.');
    } catch (err) { msg($('sosMsg'), 'err', err.message); }
  };

  /* --------------------------------------------------- the barcode test book
     A page of real Code 128 labels to print, cut up and scan: for training a
     crew, or for dry-running a count before the real one. Either from the
     count's own bins and pallets, or from a spreadsheet of whatever codes a
     site wants to practice on. */
  /* One row per practice line: the bin, the pallet in it, and the quantity a
     trainee keys in. An empty cell simply prints nothing in that column - a bin
     with no pallet is an empty bay to practice on. */
  const TEMPLATE_ROWS = [
    ['Bin', 'Pallet', 'Qty', 'Note'],
    ['F01A001', 'F01-001', 40, 'SKU-4120 Chicken breast'],
    ['F01A002', 'F01-002', 33, 'SKU-2210 Peas petite'],
    ['F01A003', 'F01-003', 28, 'SKU-6610 Salmon fillet'],
    ['F01A004', '', '', 'an empty bay to practice on'],
  ];

  async function bookTemplate() {
    try {
      /* The same spreadsheet library the uploads are read with - no second one,
         and no server round trip to build four rows. */
      if (!window.XLSX) {
        await new Promise((res, rej) => {
          const sc = document.createElement('script');
          sc.src = '/vendor/xlsx.full.min.js';
          sc.onload = res;
          sc.onerror = () => rej(new Error('Could not load the spreadsheet writer — try again, or use the CSV columns above.'));
          document.head.appendChild(sc);
        });
      }
      const ws = window.XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS);
      ws['!cols'] = [{ wch: 14 }, { wch: 18 }, { wch: 8 }, { wch: 34 }];
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Barcodes');
      window.XLSX.writeFile(wb, 'barcode-test-book-template.xlsx');
      msg($('bookMsg'), 'ok', 'Template downloaded.',
        'Type or paste your lines under the examples, keep the four column headings, then upload it back here.');
    } catch (err) { msg($('bookMsg'), 'err', err.message); }
  }

  /** Read whatever they uploaded - Excel or CSV - into rows the printer takes. */
  async function bookRowsFromFile(file) {
    const text = await fileToCsv(file);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new Error('that file has no rows in it');
    const head = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const iBin = col('bin', 'bin location', 'location', 'loc');
    const iPallet = col('pallet', 'pallet id', 'palletid', 'tag', 'lpn');
    const iQty = col('qty', 'quantity', 'count', 'cases', 'units');
    const iNote = col('note', 'notes', 'label', 'description', 'desc');
    /* The first template had a Type/Code pair rather than three columns. A site
       that filled one in should not be told to start again. */
    const iType = col('type', 'kind');
    const iCode = col('code', 'value', 'barcode');
    if (iBin < 0 && iPallet < 0 && iCode < 0) {
      throw new Error('no Bin or Pallet column — the template has Bin, Pallet, Qty, Note');
    }
    const cell = (parts, i) => (i >= 0 ? String(parts[i] ?? '').replace(/^"|"$/g, '').trim() : '');
    return lines.slice(1).map((l) => {
      const parts = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, ''));
      if (iBin < 0 && iPallet < 0) {
        const code = cell(parts, iCode);
        const pallet = /pallet/i.test(cell(parts, iType));
        return { bin: pallet ? '' : code, pallet: pallet ? code : '', qty: '', note: cell(parts, iNote) };
      }
      return {
        bin: cell(parts, iBin),
        pallet: cell(parts, iPallet),
        qty: cell(parts, iQty),
        note: cell(parts, iNote),
      };
    }).filter((r) => r.bin || r.pallet);
  }

  async function bookFromFile() {
    const file = $('fBookFile').files[0];
    if (!file) { msg($('bookMsg'), 'err', 'Pick the filled-in spreadsheet first'); return; }
    let tab;
    try {
      tab = openTab();
      const rows = await bookRowsFromFile(file);
      if (!rows.length) throw new Error('no codes in that file');
      /* The page is built by the server and opened in a tab, the same as the
         count sheets and the scanner cards - one place that knows how to draw a
         barcode, and one print layout. */
      const res = await api.call('/api/admin/print/barcode-book?qty=' + ($('fBookQty').checked ? '1' : '0'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows }),
      });
      writeTab(tab, await res.text());
      msg($('bookMsg'), 'ok', `${rows.length} line${rows.length === 1 ? '' : 's'} from ${file.name}.`,
        'Print at 100% — "fit to page" shrinks the bars and a scanner will refuse them.');
    } catch (err) {
      if (tab) tab.close();
      msg($('bookMsg'), 'err', err.message);
    }
  }

  /*
   * The tab has to be opened while the click is still the reason for it.
   * Opening it after the fetch comes back is a pop-up as far as the browser is
   * concerned, and it blocks it - so the window is opened empty on the click and
   * written into when the page arrives.
   */
  function openTab() {
    const w = window.open('', '_blank');
    if (!w) throw new Error('the browser blocked the new tab — allow pop-ups for this site');
    w.document.write('<!doctype html><title>Barcode test book</title>'
      + '<body style="font:15px system-ui;padding:24px;color:#333">Building the labels…</body>');
    return w;
  }
  function writeTab(w, html) {
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  /* The book from the count is a page of its own, opened by its address on
     the click - the way the count sheets and the scanner cards open - so it
     comes up in every browser, can be refreshed, and prints from its own tab.
     (A blank tab written into once the page arrived was left empty by some.) */
  function bookFromCount() {
    if (!needSession($('bookMsg'))) return;
    const q = new URLSearchParams({
      session: String(sessionId),
      kind: $('fBookKind').value,
      aisle: $('fBookAisle').value.trim(),
      limit: $('fBookLimit').value || '40',
      qty: $('fBookQty').checked ? '1' : '0',
      t: api.token,
    });
    const w = window.open('/api/admin/print/barcode-book?' + q.toString(), '_blank');
    if (!w) { msg($('bookMsg'), 'err', 'The browser blocked the new tab', 'Allow pop-ups for this site, then press Open the book again.'); return; }
    const s = sessions.find((x) => x.id === sessionId);
    msg($('bookMsg'), 'ok', `The book opened in a new tab${s ? `, from #${s.id} — ${s.name}` : ''}.`, 'Nothing on it? That count has no inventory report yet — upload one under Lists & racking, or pick Bins on their own.');
  }

  $('btnBookTemplate').onclick = bookTemplate;
  $('btnBookUpload').onclick = bookFromFile;
  $('btnBookPrint').onclick = bookFromCount;

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

  /* ------------------------------------------------------------ the off-site copy: OneDrive */
  let odTimer = null;
  const kb = (n) => `${Math.round((n || 0) / 1024).toLocaleString()} KB`;
  function drawOnedrive(st) {
    const state = $('odState');
    const word = st.connected ? 'connected' : st.pending ? 'waiting for sign-in' : st.configured ? 'not connected' : 'not set up';
    state.textContent = word;
    state.className = 'tag ' + (st.connected ? (st.lastError ? 'queued' : 'MATCH') : st.pending ? 'queued' : 'off');
    if (document.activeElement !== $('fOdClient')) $('fOdClient').value = st.clientId || '';
    $('fOdClient').disabled = !!st.clientIdFromEnv;
    $('fOdClient').title = st.clientIdFromEnv ? 'Set by the ONEDRIVE_CLIENT_ID variable on the server' : '';
    if (document.activeElement !== $('fOdFolder')) $('fOdFolder').value = st.folder || '';
    if (document.activeElement !== $('fOdKeep')) $('fOdKeep').value = st.keep || '';
    if (document.activeElement !== $('fOdEvery')) $('fOdEvery').value = String(st.every || 24);
    const status = $('odStatus');
    status.replaceChildren();
    let kind = 'warn';
    const line = (t, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; status.appendChild(d); };
    if (st.connected) {
      kind = st.lastError ? 'err' : 'ok';
      line(`Backups go to ${st.account || 'OneDrive'}, folder "${st.folder}" — the newest ${st.keep} are kept there.`);
      line(st.every >= 24
        ? 'A copy goes with each daily backup, and with any backup taken by hand. It is a copy at a moment, not a live sync.'
        : `A fresh copy every ${st.every === 1 ? 'hour' : `${st.every} hours`}${st.nextAt ? `, the next around ${new Date(st.nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}, as well as each daily backup. Those copies go to OneDrive only; this server keeps its dailies.`, 'detail');
      if (st.uploading) line('Sending a backup now…', 'detail');
      if (st.lastUpload) line(`Last copy: ${st.lastUpload.name} (${kb(st.lastUpload.bytes)}), ${new Date(st.lastUpload.at).toLocaleString()}.`, 'detail');
      else line('No copy sent yet — the next backup goes straight there, or press Back up to OneDrive now.', 'detail');
      if (st.lastError) line(`The last try failed (${new Date(st.lastError.at).toLocaleString()}): ${st.lastError.message}. It is tried again every half hour.`, 'detail');
    } else if (st.pending) {
      line('Waiting for someone to sign in with the code below.');
    } else if (st.configured) {
      line('Set up but not connected: press Connect OneDrive and sign in with the account the backups should go to.');
      if (st.signInError) { kind = 'err'; line(`The last sign-in did not finish: ${st.signInError}.`, 'detail'); }
    } else {
      line('Not set up. The backups are only on this server — if it is lost, so are they. The set-up below takes about five minutes, once.');
    }
    status.className = `feedback show ${kind}`;
    const code = $('odCode');
    if (st.pending) {
      code.replaceChildren();
      const big = document.createElement('div');
      big.style.fontSize = '15px';
      big.append('On any computer or phone, open ');
      const a = document.createElement('a'); a.href = st.pending.verificationUri; a.target = '_blank'; a.rel = 'noopener'; a.textContent = st.pending.verificationUri.replace(/^https?:\/\//, '');
      big.append(a, ' and type ');
      const b = document.createElement('b'); b.id = 'odUserCode'; b.style.fontSize = '20px'; b.style.letterSpacing = '.08em'; b.textContent = st.pending.userCode;
      big.append(b);
      const d = document.createElement('div'); d.className = 'detail';
      d.textContent = `Then sign in with the Microsoft account whose OneDrive should hold the backups. The code works until ${new Date(st.pending.expiresAt).toLocaleTimeString()}; this page notices by itself when it is done.`;
      code.append(big, d);
      code.classList.add('show');
    } else code.classList.remove('show');
    $('btnOdConnect').hidden = !!st.pending || st.connected;
    $('btnOdConnect').disabled = !st.configured;
    $('btnOdCancel').hidden = !st.pending;
    $('btnOdUpload').hidden = !st.connected;
    $('btnOdDisconnect').hidden = !st.connected;
    // while a sign-in is waiting, or a copy is going, keep an eye on it
    clearTimeout(odTimer);
    if (st.pending || st.uploading) odTimer = setTimeout(() => refreshOnedrive().catch(() => {}), 3000);
  }
  async function refreshOnedrive() {
    if (!api.me || api.me.role !== 'admin') { $('onedriveCard').hidden = true; return; }
    $('onedriveCard').hidden = false;
    drawOnedrive(await api.json('/api/admin/onedrive'));
  }
  const odDo = async (path, body, okText) => {
    try {
      const st = await api.post(path, body || {});
      drawOnedrive(st);
      if (okText) msg($('odMsg'), 'ok', typeof okText === 'function' ? okText(st) : okText); else clearMsg($('odMsg'));
      return st;
    } catch (err) { msg($('odMsg'), 'err', err.message); await refreshOnedrive().catch(() => {}); return null; }
  };
  $('btnOdSave').onclick = () => odDo('/api/admin/onedrive/config', {
    ...($('fOdClient').disabled ? {} : { clientId: $('fOdClient').value }),
    folder: $('fOdFolder').value, keep: Number($('fOdKeep').value) || undefined, every: Number($('fOdEvery').value),
  }, 'Saved.');
  $('btnOdConnect').onclick = () => odDo('/api/admin/onedrive/connect');
  $('btnOdCancel').onclick = () => odDo('/api/admin/onedrive/cancel');
  $('btnOdUpload').onclick = async () => {
    $('btnOdUpload').disabled = true;
    msg($('odMsg'), 'warn', 'Taking a backup and sending it…');
    await odDo('/api/admin/onedrive/upload', {}, (st) => `Sent — ${st.sent.name} (${kb(st.sent.bytes)}) is in OneDrive.`);
    $('btnOdUpload').disabled = false;
    refreshOps().catch(() => {});
  };
  $('btnOdDisconnect').onclick = () => {
    if (!confirm('Stop sending backups to OneDrive? The copies already there stay where they are.')) return;
    odDo('/api/admin/onedrive/disconnect', {}, 'Disconnected — backups stay on this server only until it is connected again.');
  };

  /* ------------------------------------------------------------ the off-site copy: Google Drive
     Through an Apps Script the admin deploys in their own Google account: no
     app registration, nothing for IT. The script, with this server's key in it,
     comes with the status. */
  /* ------------------------------------------------------------ off-site: a Teams channel's Files */
  let tbTimer = null;
  function drawTeamsBackup(st) {
    const state = $('tbState');
    state.textContent = st.on ? (st.lastError ? 'last copy failed' : 'on') : st.configured ? 'paused' : 'not set up';
    state.className = 'tag ' + (st.on ? (st.lastError ? 'queued' : 'MATCH') : 'off');
    $('fTbUrl').placeholder = st.masked ? `${st.masked} (saved — paste a new one to change it)` : 'https://…/workflows/…/triggers/manual/paths/invoke?…';
    if (document.activeElement !== $('fTbEvery')) $('fTbEvery').value = String(st.every || 24);
    const status = $('tbStatus');
    status.replaceChildren();
    let kind = 'warn';
    const line = (t, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; status.appendChild(d); return d; };
    if (st.on) {
      kind = st.lastError ? 'err' : 'ok';
      line(`Backups go to the Workflow at ${st.masked}, which saves each one into its channel's Files.`);
      line(st.every >= 24
        ? 'A copy goes with each daily backup, and with any backup taken by hand — squeezed (gzip), so it is small. Unzip it to get the database back.'
        : `A fresh copy every ${st.every === 1 ? 'hour' : `${st.every} hours`}${st.nextAt ? `, the next around ${new Date(st.nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}, as well as each daily backup.`, 'detail');
      if (st.lastTest) line(`Test file ${st.lastTest.name} sent ${new Date(st.lastTest.at).toLocaleString()}${st.lastTest.by ? ` by ${st.lastTest.by}` : ''} — check it is in the channel's Files.`, 'detail');
      else line('No test file sent yet: press Send a test file, then look in the channel\'s Files tab.', 'detail');
      if (st.uploading) line('Sending a backup now…', 'detail');
      if (st.lastUpload) line(`Last copy: ${st.lastUpload.name} (${kb(st.lastUpload.bytes)}${st.lastUpload.rawBytes ? `, ${kb(st.lastUpload.rawBytes)} unzipped` : ''}), taken by Microsoft ${new Date(st.lastUpload.at).toLocaleString()}.`, 'detail');
      else line('No backup sent yet — the next one goes by itself, or press Back up to Teams now.', 'detail');
      if (st.lastError) line(`The last try failed (${new Date(st.lastError.at).toLocaleString()}): ${st.lastError.message}. It is tried again every half hour.`, 'detail');
    } else if (st.configured) {
      line('The address is saved but sending is stopped.');
    } else {
      line('Not set up. Follow the steps below — a Teams channel and ten minutes, nothing for IT to do.');
      if (st.lastError) { kind = 'err'; line(st.lastError.message, 'detail'); }
    }
    status.className = `feedback show ${kind}`;
    $('tbHow').open = !st.on;
    $('btnTbTest').hidden = !st.configured;
    $('btnTbUpload').hidden = !st.on;
    $('btnTbDisconnect').hidden = !st.configured;
    clearTimeout(tbTimer);
    if (st.uploading) tbTimer = setTimeout(() => refreshTeamsBackup().catch(() => {}), 3000);
  }
  async function refreshTeamsBackup() {
    if (!api.me || api.me.role !== 'admin') { $('teamsBackupCard').hidden = true; return; }
    $('teamsBackupCard').hidden = false;
    drawTeamsBackup(await api.json('/api/admin/teams-backup'));
  }
  const tbDo = async (path, body, okText) => {
    try {
      const st = await api.post(path, body || {});
      drawTeamsBackup(st);
      if (okText) msg($('tbMsg'), 'ok', typeof okText === 'function' ? okText(st) : okText); else clearMsg($('tbMsg'));
      return st;
    } catch (err) { msg($('tbMsg'), 'err', err.message); await refreshTeamsBackup().catch(() => {}); return null; }
  };
  $('btnTbSave').onclick = async () => {
    const url = $('fTbUrl').value.trim();
    const st = await tbDo('/api/admin/teams-backup/config', { url, every: Number($('fTbEvery').value), on: true });
    if (!st) return;
    $('fTbUrl').value = '';
    if (!st.configured) { msg($('tbMsg'), 'warn', 'Paste the Workflow address first.', 'It is under HTTP URL in the Workflow\'s first step.'); return; }
    msg($('tbMsg'), 'ok', 'Saved.', st.lastTest ? '' : 'Now press Send a test file, and look for it in the channel\'s Files tab.');
  };
  $('btnTbTest').onclick = async () => {
    $('btnTbTest').disabled = true;
    msg($('tbMsg'), 'warn', 'Sending a test file…');
    await tbDo('/api/admin/teams-backup/test', {}, (st) => `Microsoft took it. In a minute, ${st.lastTest.name} should be in the channel's Files tab, with a card in the channel.`);
    $('btnTbTest').disabled = false;
  };
  $('btnTbUpload').onclick = async () => {
    $('btnTbUpload').disabled = true;
    msg($('tbMsg'), 'warn', 'Sending the newest backup…');
    await tbDo('/api/admin/teams-backup/upload', {}, (st) => `Sent — Microsoft took ${st.sent.name} (${kb(st.sent.bytes)}). It shows in the channel's Files in a minute.`);
    $('btnTbUpload').disabled = false;
  };
  $('btnTbDisconnect').onclick = () => {
    if (!confirm('Stop sending backups to Teams and forget the Workflow address? The copies already in the channel stay where they are.')) return;
    tbDo('/api/admin/teams-backup/disconnect', {}, 'Stopped — backups stay on this server only until an off-site copy is set up again.');
  };

  let gdTimer = null;
  let gdScript = '';
  function drawGdrive(st) {
    gdScript = st.script || '';
    $('gdScript').value = gdScript;
    const state = $('gdState');
    state.textContent = st.connected ? 'connected' : st.configured ? 'not connected' : 'not set up';
    state.className = 'tag ' + (st.connected ? (st.lastError ? 'queued' : 'MATCH') : 'off');
    if (document.activeElement !== $('fGdUrl')) $('fGdUrl').value = st.url || '';
    if (document.activeElement !== $('fGdFolder')) $('fGdFolder').value = st.folder || '';
    if (document.activeElement !== $('fGdKeep')) $('fGdKeep').value = st.keep || '';
    if (document.activeElement !== $('fGdEvery')) $('fGdEvery').value = String(st.every || 24);
    const status = $('gdStatus');
    status.replaceChildren();
    let kind = 'warn';
    const line = (t, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; status.appendChild(d); return d; };
    if (st.connected) {
      kind = st.lastError ? 'err' : 'ok';
      const l = line(`Backups go to ${st.account}'s Google Drive, folder "${st.folder}" — the newest ${st.keep} are kept there. `);
      if (st.folderUrl) { const a = document.createElement('a'); a.href = st.folderUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open the folder ↗'; l.appendChild(a); }
      line(st.every >= 24
        ? 'A copy goes with each daily backup, and with any backup taken by hand — squeezed (gzip), so it is small. Unzip it to get the database back.'
        : `A fresh copy every ${st.every === 1 ? 'hour' : `${st.every} hours`}${st.nextAt ? `, the next around ${new Date(st.nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}, as well as each daily backup.`, 'detail');
      if (st.uploading) line('Sending a backup now…', 'detail');
      if (st.lastUpload) line(`Last copy: ${st.lastUpload.name} (${kb(st.lastUpload.bytes)}${st.lastUpload.rawBytes ? `, ${kb(st.lastUpload.rawBytes)} unzipped` : ''}), ${new Date(st.lastUpload.at).toLocaleString()}.`, 'detail');
      else line('No copy sent yet — it goes in a moment, or press Back up to Google Drive now.', 'detail');
      if (st.lastError) line(`The last try failed (${new Date(st.lastError.at).toLocaleString()}): ${st.lastError.message}. It is tried again every half hour.`, 'detail');
    } else if (st.configured) {
      line('The address is saved but not checked: press Save and check the connection.');
      if (st.lastError) { kind = 'err'; line(st.lastError.message, 'detail'); }
    } else {
      line('Not set up. Follow the steps below — a Google account and ten minutes, nothing for IT to do.');
    }
    status.className = `feedback show ${kind}`;
    $('gdHow').open = !st.connected;
    $('btnGdUpload').hidden = !st.connected;
    $('btnGdDisconnect').hidden = !st.configured;
    clearTimeout(gdTimer);
    if (st.uploading) gdTimer = setTimeout(() => refreshGdrive().catch(() => {}), 3000);
  }
  async function refreshGdrive() {
    if (!api.me || api.me.role !== 'admin') { $('gdriveCard').hidden = true; return; }
    $('gdriveCard').hidden = false;
    drawGdrive(await api.json('/api/admin/gdrive'));
  }
  const gdDo = async (path, body, okText) => {
    try {
      const st = await api.post(path, body || {});
      drawGdrive(st);
      if (okText) msg($('gdMsg'), 'ok', typeof okText === 'function' ? okText(st) : okText); else clearMsg($('gdMsg'));
      return st;
    } catch (err) { msg($('gdMsg'), 'err', err.message); await refreshGdrive().catch(() => {}); return null; }
  };
  $('btnGdSave').onclick = async () => {
    const st = await gdDo('/api/admin/gdrive/config', {
      url: $('fGdUrl').value, folder: $('fGdFolder').value, keep: Number($('fGdKeep').value) || undefined, every: Number($('fGdEvery').value),
    });
    if (!st) return;
    if (!st.url) { msg($('gdMsg'), 'ok', 'Saved.'); return; }
    msg($('gdMsg'), 'warn', 'Checking with Google…');
    await gdDo('/api/admin/gdrive/check', {}, (s) => `Connected to ${s.account}. The newest backup is on its way to "${s.folder}".`);
  };
  $('btnGdUpload').onclick = async () => {
    $('btnGdUpload').disabled = true;
    msg($('gdMsg'), 'warn', 'Sending the newest backup…');
    await gdDo('/api/admin/gdrive/upload', {}, (st) => `Sent — ${st.sent.name} (${kb(st.sent.bytes)}) is in Google Drive.`);
    $('btnGdUpload').disabled = false;
  };
  $('btnGdDisconnect').onclick = () => {
    if (!confirm('Stop sending backups to Google Drive? The copies already there stay where they are.')) return;
    gdDo('/api/admin/gdrive/disconnect', {}, 'Disconnected — backups stay on this server only until it is connected again.');
  };
  $('btnGdNewKey').onclick = () => {
    if (!confirm('Make a new key? The script deployed now stops working: you paste the new one over it and deploy a new version.')) return;
    gdDo('/api/admin/gdrive/disconnect', { newKey: true }, 'A new key is in the script below. Copy it, paste it over the old one, deploy, and paste the address again.');
  };
  $('btnGdShow').onclick = () => { $('gdScript').hidden = !$('gdScript').hidden; $('btnGdShow').textContent = $('gdScript').hidden ? 'Show it' : 'Hide it'; };
  $('btnGdCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(gdScript); msg($('gdMsg'), 'ok', 'The script is copied.', 'Paste it into the script.google.com editor, over what is there.'); }
    catch {
      $('gdScript').hidden = false; $('btnGdShow').textContent = 'Hide it';
      $('gdScript').focus(); $('gdScript').select();
      msg($('gdMsg'), 'warn', 'This browser would not copy it by itself.', 'The script is selected below: press Ctrl+C.');
    }
  };

  /* ------------------------------------------------------------ systems: LIVE, TEST
     Each at its own address. On the home: the others, the link key, and who may
     use which. On another system: its name, and the home it takes people from. */
  let sysState = null;
  let sysRows = [];
  function drawSystems(st) {
    sysState = st;
    const me = st.self;
    const home = me.role === 'home';
    $('sysChip').textContent = `${me.name} · ${home ? 'home' : `linked to ${me.homeName}`}`;
    $('sysChip').className = `chip syschip c-${me.color}`;
    const colors = $('fSysColor');
    if (!colors.options.length) for (const c of st.colors) colors.appendChild(Object.assign(document.createElement('option'), { value: c, textContent: c[0].toUpperCase() + c.slice(1) }));
    if (document.activeElement !== $('fSysName')) $('fSysName').value = me.name;
    $('fSysName').disabled = me.nameFromEnv;
    colors.value = me.color;
    $('sysHomeFields').hidden = home;
    $('sysKeyField').hidden = home;
    $('sysHomeOnly').hidden = !home;
    $('sysHomeOnly2').hidden = !home;
    $('sysAccessBox').hidden = !home;
    $('sysHow').hidden = !home;
    if (!home) {
      if (document.activeElement !== $('fSysHomeUrl')) $('fSysHomeUrl').value = me.homeUrl || '';
      $('fSysHomeUrl').disabled = me.homeFromEnv;
      $('fSysKey').placeholder = st.keySet ? 'a key is set — paste a new one to change it' : 'paste the key';
      $('fSysKey').disabled = me.keyFromEnv;
    }
    const status = $('sysStatus');
    status.replaceChildren();
    const line = (t) => status.appendChild(Object.assign(document.createElement('div'), { textContent: t }));
    if (home) {
      line(st.systems.length ? `This is ${me.name}, the home system. People and scanners can switch to ${st.systems.map((s) => s.name).join(', ')} from here.` : `This is ${me.name}, the home system. No other system is listed yet.`);
      status.className = 'feedback show ' + (st.systems.length ? 'ok' : 'warn');
      sysRows = st.systems.map((s) => ({ ...s }));
      sysScan = st.scanners || 'all';
      drawSysRows();
      $('fSysKeyShow').value = st.key || '';
      drawSysAccess(st);
    } else if (st.homeIsSelf) {
      line(`The home address here, ${me.homeUrl}, is this system's own address — so Back to ${me.homeName} has nowhere to go. ${me.homeFromEnv ? 'Set SYSTEM_HOME_URL on this service in Railway' : 'Put in'} the address ${me.homeName} opens at${me.homeFromEnv ? ', and redeploy' : ''}.`);
      status.className = 'feedback show err';
    } else {
      line(st.keySet && me.homeUrl ? `This is ${me.name}, linked to ${me.homeName} at ${me.homeUrl}. People arrive from there.` : `This is ${me.name}. Put in the home system's address and its link key so people can switch here.`);
      status.className = 'feedback show ' + (st.keySet && me.homeUrl ? 'ok' : 'warn');
      drawSysScan();
    }
    if (home && (st.selfListed || []).length) {
      line(`${st.selfListed.join(', ')} is listed with this system's own address — put in the address it opens at.`);
      status.className = 'feedback show err';
    }
  }
  function drawSysRows() {
    const t = $('sysTable');
    drawSysScan();
    table(t, [{ label: 'Name' }, { label: 'Address' }, { label: 'Color' }, { label: '' }], sysRows, (s, i) => {
      const idx = sysRows.indexOf(s);
      const tr = document.createElement('tr');
      const name = Object.assign(document.createElement('input'), { value: s.name, className: 'sm sysname', maxLength: 16, placeholder: 'TEST' });
      name.oninput = () => { const was = (s.name || '').trim().toUpperCase(); s.name = name.value; if (sysScan === was) sysScan = s.name.trim().toUpperCase(); drawSysScan(); };
      const url = Object.assign(document.createElement('input'), { value: s.url, className: 'sysurl', placeholder: 'https://full-harvest-dev.up.railway.app', spellcheck: false });
      url.oninput = () => { s.url = url.value; };
      const col = document.createElement('select'); col.className = 'sm syscolor';
      for (const c of sysState.colors) col.appendChild(Object.assign(document.createElement('option'), { value: c, textContent: c }));
      col.value = s.color || 'orange'; col.onchange = () => { s.color = col.value; };
      const td = (el) => { const c = document.createElement('td'); c.appendChild(el); return c; };
      const acts = document.createElement('td');
      const chk = button('Check the link', 'sm', () => checkSystem(s.name));
      chk.dataset.check = s.name;
      chk.title = 'Ask the other system, server to server, whether a hand-off from here would work - and what to change if not';
      acts.append(chk, button('Remove', 'sm ghost', () => { sysRows.splice(idx, 1); drawSysRows(); }));
      tr.append(td(name), td(url), td(col), acts);
      return tr;
    }, 'None yet — Add a system for TEST.');
  }
  /* On the scanners: both (switched on the gun), the home alone, or one other alone.
     Chosen on the home; a linked system shows what the home chose. */
  let sysScan = 'all';
  function drawSysScan() {
    const st = sysState;
    const home = st.self.role === 'home';
    const box = $('sysScanPick');
    const me = home ? (($('fSysName').value || '').trim().toUpperCase() || st.self.name) : st.self.homeName;
    const others = home ? sysRows.map((s) => (s.name || '').trim().toUpperCase()).filter(Boolean) : [st.self.name];
    $('sysScanBox').hidden = !others.length;
    if (!others.length) return;
    const chosen = home ? sysScan : (st.scanners || 'all');
    const opts = [
      ['all', `${[me, ...others].join(' and ')} — the gun switches on its sign-on screen`],
      ['home', `${me} only`],
      ...others.map((n) => [n, `${n} only — every gun goes to ${n}`]),
    ];
    box.replaceChildren();
    for (const [v, text] of opts) {
      const r = Object.assign(document.createElement('input'), { type: 'radio', name: 'sysScan', value: v, checked: chosen === v || (v === 'home' && chosen === me), disabled: !home });
      r.onchange = () => { if (r.checked) sysScan = v; };
      const l = document.createElement('label'); l.className = 'cb'; l.append(r, document.createTextNode(' ' + text));
      box.appendChild(l);
    }
    $('sysScanHint').hidden = !home;
    if (!home) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: `Chosen on ${st.self.homeName}, under Settings → Systems there.` }));
  }
  function drawSysAccess(st) {
    const names = st.systems.map((s) => s.name);
    table($('sysAccess'), [{ label: 'Login' }, ...names.map((n) => ({ label: n }))], st.access.filter((u) => u.active), (u) => {
      const tr = document.createElement('tr');
      tr.dataset.user = u.username;
      tr.appendChild(cell(`${u.name} · ${u.username}${u.role === 'admin' ? ' (admin)' : ''}`));
      for (const n of names) {
        const td = document.createElement('td');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: u.systems.includes(n), disabled: u.role === 'admin' });
        box.dataset.system = n;
        box.title = u.role === 'admin' ? 'An admin may use every system' : `May ${u.name} switch to ${n}?`;
        box.onchange = async () => {
          const want = [...tr.querySelectorAll('input[data-system]')].filter((b) => b.checked).map((b) => b.dataset.system);
          try { drawSystems(await api.post('/api/admin/systems/access', { username: u.username, systems: want })); msg($('sysMsg'), 'ok', `${u.name}: ${want.length ? want.join(', ') : `${st.self.name} only`}.`); refreshUsers().catch(() => {}); }
          catch (err) { box.checked = !box.checked; msg($('sysMsg'), 'err', err.message); }
        };
        td.appendChild(box);
        tr.appendChild(td);
      }
      return tr;
    }, 'No logins yet.');
  }
  /* Is the other system set up to take people from here? Each check in words, with the fix. */
  async function checkSystem(name) {
    const box = $('sysCheck');
    box.hidden = false;
    box.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: `Checking ${name}…` }));
    try {
      const out = await api.post('/api/admin/systems/check', { name });
      box.replaceChildren(Object.assign(document.createElement('div'), { className: 'syscheck-head ' + (out.ok ? 'ok' : 'err'),
        textContent: out.ok ? `${out.system}: the link works — people and scanners can switch.` : `${out.system}: the link is not working yet.` }));
      for (const s of out.steps) {
        const row = document.createElement('div');
        row.className = 'syscheck-row ' + (s.ok ? 'ok' : 'err');
        row.append(Object.assign(document.createElement('i'), { textContent: s.ok ? '✓' : '✗' }), document.createTextNode(s.text));
        if (s.fix) row.appendChild(Object.assign(document.createElement('div'), { className: 'fix', textContent: s.fix }));
        box.appendChild(row);
      }
    } catch (err) { box.replaceChildren(Object.assign(document.createElement('div'), { className: 'syscheck-head err', textContent: err.message })); }
  }

  async function refreshSystems() {
    if (!api.me || api.me.role !== 'admin') { $('systemsCard').hidden = true; return; }
    $('systemsCard').hidden = false;
    drawSystems(await api.json('/api/admin/systems'));
  }
  $('btnSysAdd').onclick = () => { sysRows.push({ name: sysRows.length ? '' : 'TEST', url: '', color: 'orange', scanners: false }); drawSysRows(); const last = $('sysTable').querySelector('tbody tr:last-child .sysurl'); if (last) last.focus(); };
  $('btnSysSave').onclick = async () => {
    try {
      const home = sysState.self.role === 'home';
      const body = { color: $('fSysColor').value };
      if (!$('fSysName').disabled) body.name = $('fSysName').value;
      if (home) {
        body.systems = sysRows.map(({ scanners, ...s }) => s);
        body.scanners = sysRows.some((s) => (s.name || '').trim().toUpperCase() === sysScan) || sysScan === 'all' ? sysScan : 'home';
      }
      else {
        if (!$('fSysHomeUrl').disabled) body.homeUrl = $('fSysHomeUrl').value;
        if (!$('fSysKey').disabled && $('fSysKey').value) body.key = $('fSysKey').value;
      }
      drawSystems(await api.post('/api/admin/systems', body));
      $('fSysKey').value = '';
      msg($('sysMsg'), 'ok', 'Saved.', home ? 'People with a system ticked see Switch to… in the sidebar after their next page load.' : '');
    } catch (err) { msg($('sysMsg'), 'err', err.message); }
  };
  $('btnSysKeyShow').onclick = () => { const f = $('fSysKeyShow'); f.type = f.type === 'password' ? 'text' : 'password'; $('btnSysKeyShow').textContent = f.type === 'password' ? 'Show' : 'Hide'; };
  $('btnSysKeyCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('fSysKeyShow').value); msg($('sysMsg'), 'ok', 'The link key is copied.'); }
    catch { const f = $('fSysKeyShow'); f.type = 'text'; f.select(); msg($('sysMsg'), 'warn', 'Press Ctrl+C to copy it.'); }
  };
  $('btnSysKeyNew').onclick = async () => {
    if (!confirm('Make a new link key? Until each other system is given it, nobody can switch there.')) return;
    try { drawSystems(await api.post('/api/admin/systems', { newKey: true })); msg($('sysMsg'), 'ok', 'A new key is made.', 'Put it in each other system now.'); }
    catch (err) { msg($('sysMsg'), 'err', err.message); }
  };

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
      sel.innerHTML = '<option value="">No counts yet — make one under Count setup</option>';
      sessionId = null;
    } else {
      sessionId = sessions.some((s) => s.id === prior) ? prior : sessions[0].id;
      sel.value = String(sessionId);
    }
    applyScope();
    applySessionCard();
    await refreshAisles();
  }

  /* ---------------------------------------------------------- the count itself
     The Count session card: make a count, set its options, make it a trial,
     close or delete it. It acts on the count picked at the top of the page. */
  let layouts = [];
  let defaultSessionId = 0;
  async function loadLayouts() {
    layouts = await api.json('/api/admin/layouts');
    const sel = $('fLayout');
    sel.innerHTML = '<option value="">Schematic (auto from bin codes)</option>';
    for (const l of layouts) {
      const o = document.createElement('option');
      o.value = l.id; o.textContent = `${l.name} (${l.aisles} aisles)`;
      sel.appendChild(o);
    }
  }
  async function refreshDefaultSession() {
    defaultSessionId = (await api.json('/api/admin/default-session')).sessionId || 0;
  }
  function renderTrial(s) {
    const on = !!(s && s.trial);
    $('btnTrialOn').hidden = on || !s || s.status !== 'open';
    $('btnTrialEnd').hidden = !on;
    $('trialState').textContent = on ? 'This count is a trial run.'
      : s && s.cleared_at ? `A trial run was cleared ${new Date(s.cleared_at).toLocaleString()} — this is the real count.` : '';
  }
  function applySessionCard() {
    const s = sessions.find((x) => x.id === sessionId);
    renderTrial(s);
    if (!s) {
      $('sessionCardSub').textContent = 'no count session yet — create one below';
      return;
    }
    $('sessionCardSub').textContent = `#${s.id} · ${s.mode === 'cycle' ? 'cycle count' : 'full count'} · ${s.status}`;
    $('fPalletMode').value = s.pallet_mode;
    $('fGuided').checked = !!s.guided;
    $('fAskComments').checked = !!s.ask_comments;
    $('fAutoRecount').checked = !!s.auto_recount;
    $('fThirdCount').checked = !!s.third_count;
    $('fRecountTeamOn').checked = !!s.recount_team_on;
    $('fRecountTeam').value = s.recount_team || '';
    $('fRecMinQty').value = s.recount_min_qty || 0;
    $('fRecMinPct').value = s.recount_min_pct || 0;
    $('fRecCap').value = s.recount_cap || 0;
    $('fAskLot').checked = !!s.ask_lot;
    $('fAskExpiry').checked = !!s.ask_expiry;
    $('fRequireApproval').checked = !!s.require_approval;
    $('fApprMinQty').value = s.approval_min_qty || 0;
    $('fApprMinPct').value = s.approval_min_pct || 0;
    $('fShowOnGuns').checked = s.show_on_guns !== 0;
    $('fDefaultSession').checked = defaultSessionId === s.id;
    $('fDefaultSession').disabled = s.status === 'closed';
    $('fLayout').value = s.layout || '';
    $('btnCloseSession').textContent = s.status === 'closed' ? 'Reopen session' : 'Close session';
    // deleting is only offered once a count is closed: an open one may still have scanners on it
    $('btnDeleteSession').disabled = s.status !== 'closed';
    $('btnDeleteSession').title = s.status === 'closed'
      ? 'Delete this count and everything counted against it. This cannot be undone.'
      : 'Close the count first — an open one may still have scanners posting to it.';
  }

  $('btnTrialOn').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const lines = s.lines || 0;
    if (lines && !confirm(`This count already has ${lines.toLocaleString()} lines. Make it a trial run? Ending the trial later clears them.`)) return;
    try {
      await api.post(`/api/admin/sessions/${sessionId}/trial`, { on: true });
      msg($('trialMsg'), 'ok', 'This count is a trial run.', 'The guns show TRIAL RUN within a minute, between pallets.');
      await loadSessions();
    } catch (err) { msg($('trialMsg'), 'err', err.message); }
  };
  $('btnTrialEnd').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const typed = prompt(`End the trial run and clear it?\n\nEvery line (${(s.lines || 0).toLocaleString()}), sign-on, SOS and second count on "${s.name}" goes. The bin list, the report, the team plan and the settings stay, and the aisles go back to the start.\n\nType CLEAR to go ahead.`);
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'CLEAR') return msg($('trialMsg'), 'warn', 'Nothing cleared.', 'Type CLEAR to end the trial run.');
    try {
      const r = await api.post(`/api/admin/sessions/${sessionId}/trial`, { end: true });
      msg($('trialMsg'), 'ok', `Trial run cleared: ${r.cleared.lines.toLocaleString()} lines, ${r.cleared.signons} sign-ons.`,
        'This is the real count now. The guns forget the trial the next time they check in.');
      await loadSessions();
    } catch (err) { msg($('trialMsg'), 'err', err.message); }
  };

  /* Deleting a count is the only thing in the app that cannot be undone, so it
     says what will go before it asks, and asks for the name back when there are
     counted lines to lose. */
  $('btnDeleteSession').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    let had;
    try { had = (await api.json(`/api/admin/sessions/${sessionId}`)).contents; }
    catch (err) { return msg($('sessionMsg'), 'err', err.message); }
    const lines = [
      `${had.counts.toLocaleString()} counted lines`,
      `${had.bins.toLocaleString()} bins`,
      `${had.pallets.toLocaleString()} pallets`,
      `${had.recounts.toLocaleString()} second counts`,
      `${had.assignments.toLocaleString()} aisle assignments`,
    ].join('\n  · ');
    if (!confirm(`Delete "${s.name}" (#${s.id}) and everything under it?\n\n  · ${lines}\n\nThis cannot be undone. The audit log keeps a record that it happened.`)) return;
    let confirmName = '';
    if (had.counts > 0) {
      confirmName = prompt(`This count holds ${had.counts.toLocaleString()} counted lines.\n\nType its name exactly to confirm:\n\n${s.name}`, '');
      if (confirmName === null) return;
    }
    try {
      msg($('sessionMsg'), 'warn', 'Deleting…');
      const gone = await api.json(`/api/admin/sessions/${sessionId}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmName }),
      });
      sessionId = null;
      await refreshDefaultSession();
      await loadSessions();
      await refreshSetup().catch(() => {});
      msg($('sessionMsg'), 'ok', `Deleted "${gone.name}".`,
        gone.backup ? `A copy of the database was taken first as ${gone.backup} — Settings → Backups & log.` : 'It held no counted lines.');
    } catch (err) { msg($('sessionMsg'), 'err', 'Not deleted', err.message); }
  };

  /* Creating a count is also where its lists come from: a count with no
     inventory report to compare against is a count nobody can act on. Both
     files are optional here, and the checklist above tracks whatever is left. */
  $('btnCreate').onclick = async () => {
    const files = [['bins', $('fNewBins').files[0]], ['pallets', $('fNewPallets').files[0]]].filter(([, f]) => f);
    try {
      msg($('sessionMsg'), 'warn', 'Creating…');
      const s = await api.post('/api/admin/sessions', { name: $('fNewName').value, mode: $('fNewMode').value });
      sessionId = s.id;
      $('fNewName').value = '';
      const loaded = [];
      const failed = [];
      for (const [kind, file] of files) {
        msg($('sessionMsg'), 'warn', `Reading ${file.name}…`);
        try {
          const stats = await api.json(`/api/admin/sessions/${s.id}/master?kind=${kind}`,
            { method: 'POST', headers: { 'content-type': 'text/csv' }, body: await fileToCsv(file) });
          loaded.push(`${stats.rows.toLocaleString()} rows from ${file.name}`);
        } catch (err) { failed.push(`${file.name}: ${err.message}`); }
      }
      $('fNewBins').value = ''; $('fNewPallets').value = '';
      const what = `Created ${s.mode === 'cycle' ? 'cycle count' : 'full count'} #${s.id}.`;
      if (failed.length) {
        msg($('sessionMsg'), 'warn', what, `${loaded.length ? 'Imported ' + loaded.join(' and ') + '. ' : ''}Could not read ${failed.join('; ')}. Upload it under Lists & racking.`);
      } else if (loaded.length) {
        msg($('sessionMsg'), 'ok', what, `Imported ${loaded.join(' and ')}. The Count setup checklist above shows anything still needed.`);
      } else {
        msg($('sessionMsg'), 'ok', what, 'Next: upload its bin list and inventory report — the Count setup checklist above walks you through it.');
      }
      await loadSessions();
      await refreshSetup().catch(() => {});
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnSaveSettings').onclick = async () => {
    if (!needSession($('sessionMsg'))) return;
    try {
      if ($('fRecountTeamOn').checked && !$('fRecountTeam').value.trim()) { msg($('sessionMsg'), 'err', 'Which team?', 'Type the team number the second counts go to, or untick Send them all to team.'); $('fRecountTeam').focus(); return; }
      const saved = await api.post(`/api/admin/sessions/${sessionId}/settings`, {
        palletMode: $('fPalletMode').value, guided: $('fGuided').checked, askComments: $('fAskComments').checked,
        autoRecount: $('fAutoRecount').checked, thirdCount: $('fThirdCount').checked, layout: $('fLayout').value,
        recountTeamOn: $('fRecountTeamOn').checked, recountTeam: $('fRecountTeam').value,
        recountMinQty: $('fRecMinQty').value, recountMinPct: $('fRecMinPct').value, recountCap: $('fRecCap').value,
        askLot: $('fAskLot').checked, askExpiry: $('fAskExpiry').checked,
        requireApproval: $('fRequireApproval').checked,
        approvalMinQty: $('fApprMinQty').value, approvalMinPct: $('fApprMinPct').value,
        showOnGuns: $('fShowOnGuns').checked,
      });
      const wantDefault = $('fDefaultSession').checked;
      if (wantDefault !== (defaultSessionId === sessionId)) {
        await api.post('/api/admin/default-session', { sessionId: wantDefault ? sessionId : 0 });
        await refreshDefaultSession();
      }
      const handed = saved && saved.recountTeamHanded;
      msg($('sessionMsg'), 'ok', 'Settings saved. Scanners pick them up within about half a minute.',
        [defaultSessionId === sessionId ? 'Every scanner will land on this count at sign-on.' : '',
          handed && handed.assigned ? `${handed.assigned} open second count${handed.assigned === 1 ? '' : 's'} went to team ${handed.team}${handed.left ? `; ${handed.left} stay open for other teams (team ${handed.team} counted those bins first)` : ''}.` : ''].filter(Boolean).join(' '));
      await loadSessions();
    } catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };
  $('btnCloseSession').onclick = async () => {
    const s = sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const next = s.status === 'closed' ? 'open' : 'closed';
    if (next === 'closed' && !confirm('Close this session? Scanners will no longer be able to send counts to it.')) return;
    try { await api.post(`/api/admin/sessions/${sessionId}/status`, { status: next }); await loadSessions(); }
    catch (err) { msg($('sessionMsg'), 'err', err.message); }
  };

  /* The systems this count's report came from: offered on the upload box and
     on the ERP card, so one system's file can be made on its own. */
  async function refreshSources() {
    if (!sessionId) return;
    const { sources } = await api.json(`/api/admin/sessions/${sessionId}/sources`);
    const dl = $('sourceList');
    dl.innerHTML = '';
    for (const x of sources.filter((y) => y.source)) { const o = document.createElement('option'); o.value = x.source; dl.appendChild(o); }
    const sel = $('fErpSource');
    const was = sel.value;
    sel.innerHTML = '<option value="">All systems, one file</option>';
    for (const x of sources) {
      const o = document.createElement('option');
      o.value = x.source === '' ? '~none' : x.source;
      o.textContent = x.source ? `${x.source} only (${x.pallets.toLocaleString()} pallets)` : `Rows with no system named (${x.pallets.toLocaleString()})`;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === was)) sel.value = was;
    sel.closest('.auto').hidden = !sources.some((x) => x.source);
  }
  const erpSourceQuery = () => { const v = $('fErpSource').value; return v === '' ? '' : `?source=${encodeURIComponent(v === '~none' ? '' : v)}`; };

  function applyScope() {
    refreshSources().catch(() => {});
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
    $('scopeBar').hidden = !['lists', 'erp', 'start'].includes(e.detail);   // the panes that act on a count
    if (e.detail === 'start') {
      refreshSetup().catch((err) => msg($('startMsg'), 'err', err.message));
      refreshReady().catch(() => {});
    }
  });

  $('fSessionPick').onchange = (e) => {
    sessionId = Number(e.target.value) || null;
    applyScope();
    applySessionCard();
    refreshAisles().catch(() => {});
    refreshSetup().catch(() => {});
    refreshReady().catch(() => {});
  };

  /* ------------------------------------------------------------ ready for count day */
  const READY_WORD = { ready: 'ready', nearly: 'nearly ready', 'not-ready': 'not ready' };
  const READY_TAG = { ready: 'MATCH', nearly: 'queued', 'not-ready': 'off' };
  /* Take someone to the card a check is about: the right section, scrolled to,
     and lit for a moment so the eye finds it. */
  function goTo(f) {
    if (!f) return;
    if (f.page && f.page !== '/settings') { location.href = f.page; return; }
    api.showSub(f.sub);
    const card = f.card && document.getElementById(f.card);
    if (!card) return;
    api.unfold(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  }
  async function refreshReady() {
    if (!api.me || api.me.role !== 'admin') { $('readyCard').hidden = true; return; }
    $('readyCard').hidden = false;
    const r = await api.json('/api/admin/readiness' + (sessionId ? `?session=${sessionId}` : ''));
    $('readyState').textContent = READY_WORD[r.state];
    $('readyState').className = 'tag ' + READY_TAG[r.state];
    const head = r.state === 'ready' ? 'Everything the site needs for a count is in place.'
      : r.fails ? `${r.fails} thing${r.fails === 1 ? '' : 's'} will stop the count going as planned${r.warns ? `, and ${r.warns} worth a look` : ''}.`
      : `${r.warns} thing${r.warns === 1 ? '' : 's'} worth a look before count day.`;
    msg($('readyMsg'), r.state === 'ready' ? 'ok' : r.fails ? 'err' : 'warn', head, r.session ? `Checked against "${r.session.name}" and the site's settings.` : 'There is no full count to check against yet.');
    const list = $('readyList');
    list.replaceChildren();
    for (const c of r.checks) {
      const li = document.createElement('li');
      li.className = 'check ' + c.level;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✕';
      const text = document.createElement('div');
      text.className = 'what';
      const b = document.createElement('b'); b.textContent = c.title;
      const d = document.createElement('span'); d.textContent = c.detail || '';
      text.append(b, d);
      li.append(mark, text);
      if (c.fix && c.level !== 'ok') li.appendChild(button(`${c.fix.label} →`, 'sm ghost', () => goTo(c.fix)));
      list.appendChild(li);
    }
  }
  $('btnReadyRecheck').onclick = () => refreshReady().catch((err) => msg($('readyMsg'), 'err', err.message));

  /* ------------------------------------------------------------ boot */
  function show(which) {
    $('scrLogin').classList.toggle('active', which === 'login');
    $('scrMain').classList.toggle('active', which === 'main');
  }

  async function load() {
    await refreshMe();
    await Promise.all([refreshDevices(), refreshErp(), refreshOps(), refreshPrompts(), refreshJobs().catch(() => {}), refreshReasons(), refreshSosSettings(), refreshIssueMenu().catch(() => {}), refreshLogo(), refreshPalletSystem().catch(() => {}), refreshOnedrive().catch(() => {}), refreshGdrive().catch(() => {}), refreshTeamsBackup().catch(() => {}), refreshCrewBoard().catch(() => {}), refreshSystems().catch(() => {})]);
    drawOverride();
    await refreshFeatures().catch(() => {});
    await refreshGun().catch(() => {});
    await loadLayouts().catch(() => {});
    await refreshDefaultSession().catch(() => {});
    await loadSessions();
    await refreshSetup().catch(() => {});
    await refreshReady().catch(() => {});
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
