import { describe, expect, it } from 'vitest';
import { inQuietHours, overridesQuietHours, quietHoursEnd, render, TEMPLATES, type TemplateKey } from './templates.js';

/** IST is UTC+05:30 with no daylight saving. */
const ist = (hh: number, mm = 0) => new Date(Date.UTC(2026, 8, 23, hh, mm) - 330 * 60_000);

describe('notifications — templates', () => {
  it('notifications R3: quiet hours are 22:00–07:00 IST', () => {
    expect(inQuietHours(ist(21, 59))).toBe(false);
    expect(inQuietHours(ist(22, 0))).toBe(true);
    expect(inQuietHours(ist(3, 0))).toBe(true);
    expect(inQuietHours(ist(6, 59))).toBe(true);
    expect(inQuietHours(ist(7, 0))).toBe(false);
  });

  it('notifications R3: a held push goes out at the next 07:00 IST', () => {
    expect(quietHoursEnd(ist(23, 30)).toISOString()).toBe(new Date(ist(7, 0).getTime() + 86_400_000).toISOString());
    // 03:00 IST is already the next calendar day in IST but 21:30 UTC the day before.
    expect(quietHoursEnd(ist(3, 0)).toISOString()).toBe(ist(7, 0).toISOString());
    expect(quietHoursEnd(ist(6, 59)).toISOString()).toBe(ist(7, 0).toISOString());
  });

  it('notifications R3: only a match starting soon overrides them', () => {
    const overriding = (Object.keys(TEMPLATES) as TemplateKey[]).filter(overridesQuietHours);
    expect(overriding).toEqual(['match.starting_soon']);
  });

  it('notifications R4: copy comes from the registry, keyed and typed', () => {
    expect(render('registration.confirmed', { eventTitle: 'Open', categoryName: 'Singles' })).toEqual({
      title: "You're in",
      body: 'Open · Singles. Your check-in code is in My PL4Y.',
    });
  });

  it('notifications R4: a key this build does not know renders nothing rather than throwing', () => {
    expect(render('something.new', {})).toBeNull();
  });

  it('notifications R11: user text is carried as a payload field, untouched', () => {
    const message = '<b>Courts moved</b> to Hall B';
    expect(render('organizer.message', { eventTitle: 'Open', message })?.body).toBe(message);
  });

  it('scoring R11: the confirm request says when it confirms itself, and old rows still render', () => {
    expect(render('match.result_pending', { eventTitle: 'Open', autoConfirmMinutes: 60 })?.body).toBe(
      'Open. The other side entered a score — confirm or dispute it. It confirms automatically in 60 minutes.',
    );
    expect(render('match.result_pending', { eventTitle: 'Open', autoConfirmMinutes: null })?.body).toBe(
      'Open. The other side entered a score — check it and confirm.',
    );
    // A feed row written before this change has no autoConfirmMinutes.
    expect(render('match.result_pending', { eventTitle: 'Open' })?.body).toBe(
      'Open. The other side entered a score — check it and confirm.',
    );
  });

  it('scoring R14: the reminder', () => {
    expect(render('match.result_reminder', { eventTitle: 'Open', autoConfirmMinutes: 30 })).toEqual({
      title: 'Your result is waiting',
      body: 'Open. Confirm or dispute — it confirms automatically in 30 minutes.',
    });
    expect(render('match.result_reminder', { eventTitle: 'Open', autoConfirmMinutes: null })?.body).toBe(
      'Open. Confirm or dispute your result.',
    );
  });

  it('scoring R13: the organizer alert counts results', () => {
    expect(render('match.results_waiting', { eventTitle: 'Open', count: 1 })?.title).toBe('1 result is waiting');
    expect(render('match.results_waiting', { eventTitle: 'Open', count: 3 })).toEqual({
      title: '3 results are waiting',
      body: 'Open. Nobody has confirmed them yet — you can confirm them now.',
    });
  });

  it('a result confirmed automatically says so; an old row without the flag does not', () => {
    expect(render('match.result', { eventTitle: 'Open', won: true, auto: true })?.body).toBe(
      'Open. On to the next round. Confirmed automatically.',
    );
    expect(render('match.result', { eventTitle: 'Open', won: false })?.body).toBe('Open. Good game.');
    expect(render('match.result', { eventTitle: 'Open', won: false, drawn: true, league: true })).toEqual({
      title: 'It’s a draw',
      body: 'Open. A point each.',
    });
    expect(render('match.result', { eventTitle: 'Open', won: true, league: true })?.body).toBe('Open. Three points.');
    // A final or third-place win has no next round to promise.
    expect(render('match.result', { eventTitle: 'Open', won: true, last: true })?.body).toBe('Open. Well played.');
    // F4 — with no neutral organizer the players are told PL4Y settles it.
    expect(render('match.result_disputed', { eventTitle: 'Open', audience: 'player', reviewer: 'pl4y' })?.body).toBe(
      'Open. PL4Y will review the score.',
    );
    expect(render('match.result_disputed', { eventTitle: 'Open', audience: 'player' })?.body).toBe(
      'Open. The organizer will review the score.',
    );
  });

  it('a settled rating change', () => {
    expect(render('rating.changed', { sportName: 'Pickleball', rating: 1612.4, delta: 23.6 })).toEqual({
      title: 'Rating up 24 in Pickleball',
      body: 'Your PL4Y rating is now 1612.',
    });
    expect(render('rating.changed', { sportName: 'Pickleball', rating: 1480, delta: -12.2 })?.title).toBe(
      'Rating down 12 in Pickleball',
    );
  });
});
