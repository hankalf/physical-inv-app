/*
 * Shared test helpers.
 *
 * The supervisor pages are split into sub-tabs, so most of a page is display:none
 * at any moment and Playwright rightly refuses to type into it. These suites are
 * about what the pages DO, not about which tab a control sits behind, so they
 * flatten the tabs after signing in and assert on everything at once.
 *
 * The tab mechanism itself is covered explicitly - see "sub-tabs" in
 * full-count.mjs and settings.mjs - so flattening here hides nothing.
 */
export async function expandSubTabs(page) {
  await page.addStyleTag({ content: '[data-sub] { display: block !important; }' });
  /* a page fetches a sub-tab's data when that tab is shown; flattened, every
     tab is shown, so say so for each one */
  await page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-sub]')];
    // the tab that really is current goes last, so a page keeps its state on it
    for (const pane of [...panes.filter((p) => !p.classList.contains('active')), ...panes.filter((p) => p.classList.contains('active'))]) {
      document.dispatchEvent(new CustomEvent('subshow', { detail: pane.dataset.sub }));
    }
  }).catch(() => {});
  await page.waitForTimeout(600);
}

/** Sign in on a supervisor page and flatten the tabs. */
export async function signIn(page, { user = '', password = 'changeme' } = {}) {
  if (user) await page.fill('#fUser', user);
  await page.fill('#fPassword', password);
  await page.click('#btnLogin');
  await page.waitForSelector('#scrMain.active');
  await expandSubTabs(page);
  await page.waitForTimeout(400);
}

/**
 * Pick a count session from the header picker.
 *
 * It is a real menu now, not a <select>, so this drives it the way a person
 * does: open it, click the row. Falls back to a <select> on the pages that
 * still have one.
 */
export async function pickSession(page, id) {
  const menu = await page.$('#sessionPick .sess-btn');
  if (menu) {
    await menu.click();
    await page.waitForSelector('#sessionPick .sess-menu:not([hidden])', { timeout: 5000 });
    await page.click(`#sessionPick .sess-row[data-id="${id}"]`);
  } else {
    await page.selectOption('#fSessionPick', String(id));
  }
  await page.waitForTimeout(1200);
}

/**
 * A stand-in for an in-house ASP.NET pallet system: a sign-in that sets its
 * cookies without SameSite=None, refuses to be framed, redirects with an
 * absolute address, and links its stylesheet root-relatively - everything
 * that goes wrong in another site's frame, and that the pass-through in
 * pallet-proxy.js has to turn round.
 */
export async function fakeAspx() {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).filter((p) => p[0]));
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Powered-By', 'ASP.NET');
    const origin = `http://127.0.0.1:${srv.address().port}`;
    if (u.pathname === '/WebResource.axd') { res.setHeader('content-type', 'text/css'); return res.end('body{font-family:sans-serif}'); }
    if (u.pathname === '/Login.aspx' && req.method === 'GET') {
      res.setHeader('Set-Cookie', ['ASP.NET_SessionId=sess1; path=/; HttpOnly']);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><head><link rel="stylesheet" href="/WebResource.axd?d=1"></head><body><h1>Sign in to the WMS</h1><form id="aspnetForm" method="post" action="/Login.aspx?ReturnUrl=${encodeURIComponent(u.searchParams.get('ReturnUrl') || '/Move.aspx')}"><input name="user" id="user"><input name="pw" id="pw" type="password"><button id="go" type="submit">Log in</button></form><a href="${origin}/Help.aspx">help</a></body></html>`);
    }
    if (u.pathname === '/Login.aspx' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; });
      return req.on('end', () => {
        const f = new URLSearchParams(body);
        if (!cookies['ASP.NET_SessionId']) { res.statusCode = 400; return res.end('no session cookie: the sign-in cannot stick'); }
        if (f.get('user') === 'dana' && f.get('pw') === 'secret') {
          res.setHeader('Set-Cookie', ['.ASPXAUTH=ok; path=/; HttpOnly']);
          res.statusCode = 302; res.setHeader('Location', origin + (u.searchParams.get('ReturnUrl') || '/Move.aspx')); return res.end();
        }
        res.statusCode = 200; res.setHeader('content-type', 'text/html'); return res.end('<h1>Wrong password</h1>');
      });
    }
    if (u.pathname === '/Move.aspx') {
      if (cookies['.ASPXAUTH'] !== 'ok') { res.statusCode = 302; res.setHeader('Location', `/Login.aspx?ReturnUrl=${encodeURIComponent(u.pathname + u.search)}`); return res.end(); }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><body><h1 id="welcome">Welcome dana - move ${u.searchParams.get('pallet') || '?'} to ${u.searchParams.get('to') || '?'}</h1><img src="/img/logo.png"></body></html>`);
    }
    res.statusCode = 404; res.end('not here');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
