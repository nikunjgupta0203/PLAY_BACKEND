/**
 * Building blocks for transactional email (ADR 0002). Every template composes
 * these into `layout()`, so all mail shares one frame: the Floodlight palette
 * from the player app, inlined because most clients strip <style>, and tables
 * because Outlook still lays out nothing else. Web fonts load where the client
 * allows them (Apple Mail, iOS); elsewhere the stacks fall back.
 *
 * Templates are pure: data in, `{ subject, text, html }` out. Each owning
 * module keeps its own templates (R12) and sends them through platform/email.
 */
import { config } from './config.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const C = {
  ground: '#0F0F0A',
  surface: '#1E1E17',
  raised: '#26261E',
  line: '#36362E',
  ink: '#F5F5EF',
  ink2: '#A5A59E',
  ink3: '#787870',
} as const;

export type Tone = 'brand' | 'red' | 'blue' | 'amber';
/** [foreground, soft fill, border] for each tone. */
const TONES: Record<Tone, [string, string, string]> = {
  brand: ['#D3EF1F', '#2F3608', '#4C5617'],
  red: ['#FF6B6B', '#3A1616', '#5C2323'],
  blue: ['#7FB2FF', '#14223A', '#24395C'],
  amber: ['#F2B45A', '#3A2A10', '#5C4319'],
};

const DISPLAY = "'Archivo','Arial Black','Helvetica Neue',Arial,sans-serif";
const BODY = "'Manrope','Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'DM Mono','SFMono-Regular',Menlo,Consolas,monospace";

const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** An absolute link for a button. Paths are app routes under EMAIL_LINK_BASE. */
export const link = (path: string) => `${config.EMAIL_LINK_BASE.replace(/\/$/, '')}${path}`;

// --- formatting ---------------------------------------------------------------

/** `₹1,234.00` — Indian digit grouping. */
export function rupees(paise: bigint): string {
  return `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `Sun, 12 Oct 2026` in the event's own timezone. */
export function day(at: Date, timeZone = 'Asia/Kolkata'): string {
  return at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone });
}

/** `7:00 AM IST`. */
export function clock(at: Date, timeZone = 'Asia/Kolkata'): string {
  const t = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone });
  return `${t} ${zoneName(at, timeZone)}`;
}

function zoneName(at: Date, timeZone: string): string {
  if (timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta') return 'IST';
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

// --- blocks -------------------------------------------------------------------

export const eyebrow = (label: string, tone: Tone = 'brand') =>
  `<p style="margin:0 0 14px;font-family:${MONO};font-size:11px;line-height:14px;letter-spacing:1.6px;text-transform:uppercase;color:${TONES[tone][0]};">&#9679;&nbsp; ${label}</p>`;

export const title = (t: string) =>
  `<h1 style="margin:0 0 12px;font-family:${DISPLAY};font-size:30px;line-height:32px;font-weight:900;letter-spacing:-1.2px;text-transform:uppercase;color:${C.ink};">${t}</h1>`;

export const lead = (html: string) =>
  `<p style="margin:0 0 26px;font-family:${BODY};font-size:15px;line-height:23px;color:${C.ink2};">${html}</p>`;

export const para = (html: string) =>
  `<p style="margin:0;font-family:${BODY};font-size:13px;line-height:20px;color:${C.ink2};">${html}</p>`;

/** Inline emphasis inside lead/para copy. */
export const strong = (t: string) => `<b style="color:${C.ink};">${esc(t)}</b>`;

export const divider = () =>
  `<table ${TABLE} style="margin:28px 0 22px;"><tr><td style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;

/** The one primary action. Full width, so it is a thumb target on a phone. */
export const button = (label: string, href: string, tone: Tone = 'brand') => {
  const bg = TONES[tone][0];
  return `<table ${TABLE}><tr><td align="center" bgcolor="${bg}" style="background:${bg};border-radius:14px;">
<a href="${esc(href)}" style="display:block;padding:16px 20px;font-family:${DISPLAY};font-size:15px;line-height:18px;font-weight:900;letter-spacing:.4px;text-transform:uppercase;color:${C.ground};text-decoration:none;">${label} &nbsp;&rarr;</a></td></tr></table>`;
};

/** Two quieter actions side by side, under the primary button. */
export const secondaryPair = (a: [string, string], b: [string, string]) => {
  const cell = ([label, href]: [string, string]) =>
    `<a href="${esc(href)}" style="display:block;text-align:center;padding:12px;border:1px solid ${C.line};border-radius:12px;font-family:${BODY};font-size:13px;font-weight:700;color:${C.ink};text-decoration:none;">${label}</a>`;
  return `<table ${TABLE} style="margin:10px 0 0;"><tr><td width="50%" style="padding-right:5px;">${cell(a)}</td><td width="50%" style="padding-left:5px;">${cell(b)}</td></tr></table>`;
};

export const codeBox = (code: string, tone: Tone = 'brand') => {
  const [fg, soft, line] = TONES[tone];
  return `<table ${TABLE}><tr><td align="center" bgcolor="${soft}" style="background:${soft};border:1px solid ${line};border-radius:16px;padding:22px 12px;">
<span class="code" style="font-family:${MONO};font-size:40px;line-height:44px;font-weight:500;letter-spacing:12px;color:${fg};white-space:nowrap;">${esc(code)}</span></td></tr></table>`;
};

export const caption = (html: string) =>
  `<p style="margin:12px 0 22px;font-family:${BODY};font-size:12.5px;line-height:18px;font-weight:600;color:${C.ink3};text-align:center;">${html}</p>`;

/** A typed fallback under a button: "Or open PL4Y and enter code ABC". */
export const fallbackCode = (label: string, code: string) =>
  `<p style="margin:12px 0 0;text-align:center;font-family:${BODY};font-size:12.5px;line-height:18px;color:${C.ink3};">${label} <b style="font-family:${MONO};color:${C.ink};letter-spacing:1px;">${esc(code)}</b></p>`;

const kv = (k: string, v: string) =>
  `<p style="margin:0;font-family:${MONO};font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:${C.ink3};">${k}</p><p style="margin:3px 0 0;font-family:${BODY};font-size:14px;line-height:20px;font-weight:700;color:${C.ink};">${esc(v)}</p>`;

export interface TicketEvent {
  title: string;
  startsAt: Date;
  timezone?: string;
  /** "Koramangala Indoor Arena, Bengaluru" or just the city. */
  place?: string | null;
}

/** The event card every event email shares. */
export const ticket = (ev: TicketEvent, stamp?: { text: string; tone: Tone }, kicker?: string) => {
  const s = stamp ? TONES[stamp.tone] : null;
  return `<table ${TABLE} bgcolor="${C.raised}" style="background:${C.raised};border:1px solid ${C.line};border-radius:16px;margin:0 0 24px;">
<tr><td style="padding:18px 20px 14px;">
  <table ${TABLE}><tr>
    <td style="font-family:${MONO};font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${C.ink3};">${esc(kicker ?? 'Event')}</td>
    ${stamp && s ? `<td align="right"><span style="display:inline-block;padding:4px 9px;border-radius:999px;border:1px solid ${s[2]};background:${s[1]};font-family:${MONO};font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:${s[0]};">${esc(stamp.text)}</span></td>` : ''}
  </tr></table>
  <p style="margin:10px 0 0;font-family:${DISPLAY};font-size:21px;line-height:24px;font-weight:900;letter-spacing:-.6px;color:${C.ink};">${esc(ev.title)}</p>
</td></tr>
<tr><td style="border-top:1px dashed ${C.line};padding:14px 20px 18px;">
  <table ${TABLE}>
    <tr><td width="50%" valign="top" style="padding-right:10px;">${kv('When', day(ev.startsAt, ev.timezone))}</td><td width="50%" valign="top">${kv('Starts', clock(ev.startsAt, ev.timezone))}</td></tr>
    ${ev.place ? `<tr><td colspan="2" style="padding-top:12px;">${kv('Where', ev.place)}</td></tr>` : ''}
  </table>
</td></tr></table>`;
};

/** Label/value rows, values already escaped or formatted by the caller. */
export const rows = (items: [string, string][], total?: [string, string]) =>
  `<table ${TABLE} style="margin:0 0 24px;">
${items
  .map(
    ([k, v]) =>
      `<tr><td style="padding:8px 12px 8px 0;font-family:${BODY};font-size:14px;color:${C.ink2};border-bottom:1px solid ${C.line};">${k}</td><td align="right" style="padding:8px 0;font-family:${MONO};font-size:13.5px;color:${C.ink};border-bottom:1px solid ${C.line};">${v}</td></tr>`,
  )
  .join('')}
${total ? `<tr><td style="padding:12px 0 0;font-family:${BODY};font-size:14px;font-weight:700;color:${C.ink};">${total[0]}</td><td align="right" style="padding:12px 0 0;font-family:${DISPLAY};font-size:22px;font-weight:900;letter-spacing:-.5px;color:${TONES.brand[0]};">${total[1]}</td></tr>` : ''}
</table>`;

export interface Step {
  label: string;
  when: string;
  state: 'done' | 'now' | 'todo';
}

/** A vertical tracker: done steps in brand, the current one in blue. */
export const steps = (list: Step[]) =>
  `<table ${TABLE} style="margin:0 0 24px;">
${list
  .map((s, i) => {
    const col = s.state === 'done' ? TONES.brand[0] : s.state === 'now' ? TONES.blue[0] : C.line;
    const last = i === list.length - 1;
    return `<tr><td width="22" valign="top">
  <div style="width:14px;height:14px;border-radius:50%;background:${s.state === 'todo' ? 'transparent' : col};border:2px solid ${col};box-sizing:border-box;margin-top:3px;"></div>
  ${last ? '' : `<div style="width:2px;height:30px;background:${s.state === 'done' ? TONES.brand[0] : C.line};margin:2px 0 0 6px;"></div>`}
</td><td valign="top" style="padding:0 0 ${last ? 0 : 10}px 10px;">
  <p style="margin:0;font-family:${BODY};font-size:14px;line-height:20px;font-weight:700;color:${s.state === 'todo' ? C.ink3 : C.ink};">${esc(s.label)}</p>
  <p style="margin:1px 0 0;font-family:${MONO};font-size:11.5px;line-height:16px;color:${C.ink3};">${esc(s.when)}</p>
</td></tr>`;
  })
  .join('')}
</table>`;

/** A tinted callout. `head` is bold in the tone colour, `body` follows. */
export const note = (head: string, body: string, tone: Tone = 'amber') => {
  const [fg, soft, line] = TONES[tone];
  return `<table ${TABLE} style="margin:0 0 24px;"><tr><td bgcolor="${soft}" style="background:${soft};border:1px solid ${line};border-radius:12px;padding:12px 14px;font-family:${BODY};font-size:13px;line-height:19px;color:${C.ink};"><span style="color:${fg};font-weight:700;">${esc(head)}</span> ${esc(body)}</td></tr></table>`;
};

/** Who sent this: initials disc, name, one line of context. */
export const person = (name: string, sub: string) => {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 2);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>
<td width="48" valign="middle"><div style="width:44px;height:44px;border-radius:50%;background:${TONES.brand[0]};color:${C.ground};text-align:center;line-height:44px;font-family:${DISPLAY};font-weight:900;font-size:16px;">${esc(initials || '?')}</div></td>
<td valign="middle" style="padding-left:12px;"><p style="margin:0;font-family:${BODY};font-size:15px;font-weight:700;color:${C.ink};">${esc(name)}</p><p style="margin:2px 0 0;font-family:${BODY};font-size:12.5px;color:${C.ink3};">${esc(sub)}</p></td></tr></table>`;
};

// --- the frame ----------------------------------------------------------------

export function layout(args: { subject: string; preheader: string; to: string; body: string }): string {
  const { subject, preheader, to, body } = args;
  const footerLink = (label: string, href: string) =>
    `<a href="${esc(href)}" style="color:${C.ink2};text-decoration:none;">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800;900&family=DM+Mono:wght@400;500&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:${C.ground}; }
  @media (max-width:520px) {
    .card { padding:30px 20px !important; }
    .outer { padding:24px 10px 36px !important; }
    .code { font-size:32px !important; letter-spacing:7px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table ${TABLE} bgcolor="${C.ground}" style="background:${C.ground};">
<tr><td class="outer" align="center" style="padding:40px 16px 48px;">
<table ${TABLE} style="max-width:500px;">
  <tr><td style="padding:0 6px 20px;">
    <table ${TABLE}><tr>
      <td style="font-family:${DISPLAY};font-size:26px;line-height:26px;font-weight:900;letter-spacing:-1px;color:${C.ink};">PL<span style="color:${TONES.brand[0]};">4</span>Y<span style="color:${TONES.brand[0]};font-size:14px;vertical-align:top;line-height:14px;">&#9679;</span></td>
      <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:${C.ink3};">getpl4y.com</td>
    </tr></table>
  </td></tr>
  <tr><td class="card" bgcolor="${C.surface}" style="background:${C.surface};border:1px solid ${C.line};border-radius:21px;padding:38px 34px;">
${body}
  </td></tr>
  <tr><td style="padding:22px 6px 0;font-family:${BODY};font-size:12px;line-height:18px;color:${C.ink3};">
    Sent to ${esc(to)} by PL4Y.<br>
    ${footerLink('Help', 'https://getpl4y.com/help')} &nbsp;&middot;&nbsp; ${footerLink('Privacy', 'https://getpl4y.com/privacy')} &nbsp;&middot;&nbsp; ${footerLink('getpl4y.com', 'https://getpl4y.com')}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text twin, signed off the same way as the HTML footer. */
export const plain = (lines: string[]) => [...lines, '', 'PL4Y · getpl4y.com'].join('\n');
