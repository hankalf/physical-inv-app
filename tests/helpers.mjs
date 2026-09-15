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
