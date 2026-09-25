import { db } from '../db.js';

/*
 * Sending an alert on to Microsoft Teams.
 *
 * The dashboard is the place an SOS lands, but nobody stares at a dashboard.
 * The office already lives in a Teams channel, so the same alert goes there
 * too - with the team, the aisle and what is wrong in the first line, because
 * that is all anybody reads on a phone notification.
 *
 * A Teams channel gives out an HTTPS address that takes a POST and posts what
 * it is sent. There are two kinds in the wild:
 *
 *   - a Workflows / Power Automate URL ("When a Teams webhook request is
 *     received"), which is what Microsoft points people at now;
 *   - the older Office 365 connector URL, which Microsoft is retiring.
 *
 * Both accept the same envelope - a message carrying an Adaptive Card - so this
 * sends that and works with either. Nothing here is Teams-specific beyond the
 * card: any endpoint that takes a JSON POST will receive it, which is what makes
 * it testable without the internet.
 */

const KEY = 'teamsWebhook';
const originOf = (url) => { try { return new URL(url).origin; } catch { return String(url).slice(0, 24); } };
const TIMEOUT_MS = 6000;

export function teamsConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  const url = String(saved.url || '');
  return {
    url,
    on: !!saved.on && !!url,
    tellWhenClosed: saved.tellWhenClosed !== false,
    /* The address is a key: anybody who has it can post into that channel, and
       what makes it a key is the signature at the end. The page is shown enough
       to recognise which channel it is - the host - and nothing that would let
       somebody else post. */
    masked: url ? `${originOf(url)}/…` : '',
    configured: !!url,
  };
}

export function saveTeamsConfig(body = {}) {
  const now = teamsConfig();
  /* An empty URL from the page means "leave it alone" - the page only ever has
     the masked one - and the word "clear" means take it off. */
  let url = body.url === undefined ? now.url : String(body.url).trim();
  if (url === 'clear') url = '';
  /* https, because the address is a key and it crosses the internet. The one
     exception is this machine: a site testing the wiring, or running the whole
     thing on its own network, has nowhere to get a certificate from. */
  const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\//i.test(url);
  if (url && !/^https:\/\//i.test(url) && !loopback) {
    throw Object.assign(new Error('a Teams webhook address has to start with https:// (http:// is allowed only for 127.0.0.1)'), { status: 400 });
  }
  const value = {
    url,
    on: body.on === undefined ? now.on : !!body.on,
    tellWhenClosed: body.tellWhenClosed === undefined ? now.tellWhenClosed : !!body.tellWhenClosed,
  };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(value));
  return teamsConfig();
}

const fact = (title, value) => ({ title, value: String(value ?? '') });

/** The card a channel shows for one alert. */
export function alertCard(alert, { site = 'Physical inventory', dashboard = '' } = {}) {
  const urgent = alert.status !== 'closed';
  const facts = [
    fact('Team', alert.team || '—'),
    fact('Scanner', alert.device_id || '—'),
    alert.aisle ? fact('Aisle', alert.aisle) : null,
    alert.bin ? fact('Last bin', alert.bin) : null,
    alert.employees ? fact('On the gun', alert.employees) : null,
    fact('Raised', new Date(alert.created_at).toLocaleString('en-US')),
  ].filter(Boolean);

  const body = [
    {
      type: 'TextBlock', text: urgent ? `SOS from team ${alert.team || '?'}` : `Cleared: team ${alert.team || '?'}`,
      weight: 'Bolder', size: 'Large', color: urgent ? 'Attention' : 'Good', wrap: true,
    },
    { type: 'TextBlock', text: alert.reason, weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'None' },
  ];
  if (alert.detail) body.push({ type: 'TextBlock', text: alert.detail, wrap: true, isSubtle: true });
  if (alert.status === 'closed' && alert.outcome) {
    body.push({ type: 'TextBlock', text: `Closed by ${alert.closed_by || 'a supervisor'}: ${alert.outcome}`, wrap: true, color: 'Good' });
  }
  body.push({ type: 'FactSet', facts });
  body.push({ type: 'TextBlock', text: site, isSubtle: true, size: 'Small', spacing: 'Medium', wrap: true });

  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
  };
  if (dashboard) {
    card.actions = [{ type: 'Action.OpenUrl', title: 'Open the dashboard', url: dashboard }];
  }
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] };
}

export const testCard = (who) => alertCard({
  team: '—', device_id: 'test', reason: 'Test from the inventory app',
  detail: `Sent by ${who || 'a supervisor'} to check this channel is wired up. No action needed.`,
  created_at: new Date().toISOString(), status: 'open',
});

/**
 * Post to the channel.
 *
 * Never throws at the caller: an SOS that reached the dashboard has done its
 * main job, and a Teams outage must not fail the handheld's request or lose the
 * alert. What happened is recorded on the alert instead, so a supervisor can see
 * that the channel did not get it.
 */
export async function postToTeams(payload, { url = '' } = {}) {
  const cfg = teamsConfig();
  const to = url || cfg.url;
  if (!to) return { sent: false, why: 'no Teams address set' };
  const stop = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  try {
    const res = await fetch(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: stop,
    });
    const text = (await res.text().catch(() => '')).slice(0, 200);
    if (!res.ok) return { sent: false, why: `Teams said ${res.status}${text ? ': ' + text : ''}` };
    return { sent: true, why: text || 'accepted' };
  } catch (err) {
    return { sent: false, why: err.name === 'TimeoutError' ? 'Teams did not answer in time' : err.message };
  }
}
