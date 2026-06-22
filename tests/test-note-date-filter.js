'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLeadingDate, filterNoteByStayWindow, tidyNotes, extractEstimatedTime } = require('../src/opera-db-query');

const TODAY = '2026-05-26';

test('parseLeadingDate — numeric day-first formats', () => {
  assert.strictEqual(parseLeadingDate('21/04/26 welcome amenity', TODAY), '2026-04-21');
  assert.strictEqual(parseLeadingDate('21-04-2026 incident', TODAY), '2026-04-21');
  // Reported gap #1: spaces around the separators must still parse.
  assert.strictEqual(parseLeadingDate('21 / 04 / 26 spaced', TODAY), '2026-04-21');
  assert.strictEqual(parseLeadingDate('1 / 2 / 27 mixed widths', TODAY), '2027-02-01');
});

test('parseLeadingDate — month-name day-first formats', () => {
  // Reported gap #2: DD + 3-letter month with a trailing clock time, no year.
  // Year defaults to today's year; the "09:38" time is not read as a year.
  assert.strictEqual(parseLeadingDate('21FEB 09:38 > 10:45', TODAY), '2026-02-21');
  assert.strictEqual(parseLeadingDate('21 FEB 26 with year', TODAY), '2026-02-21');
  assert.strictEqual(parseLeadingDate('21-FEB-2026 oracle style', TODAY), '2026-02-21');
  // Spanish month abbreviations (Argentine staff).
  assert.strictEqual(parseLeadingDate('2 ABR check', TODAY), '2026-04-02');
  assert.strictEqual(parseLeadingDate('10DIC fiesta', TODAY), '2026-12-10');
});

test('parseLeadingDate — guards against non-dates', () => {
  assert.strictEqual(parseLeadingDate('Likes red wine', TODAY), null);
  assert.strictEqual(parseLeadingDate('3 BTL malbec', TODAY), null);   // not a month
  assert.strictEqual(parseLeadingDate('32/13/26 garbage', TODAY), null); // out of range
  assert.strictEqual(parseLeadingDate('', TODAY), null);
});

test('filterNoteByStayWindow — drops past spaced/month-name chunks', () => {
  const note = [
    '[Note] Allergy: shellfish',         // undated header → kept
    '21 / 04 / 26 spilled wine',         // past (spaced) → dropped
    '21FEB 09:38 > 10:45 early checkin',  // past (month-name, no year) → dropped
    '28/05/26 anniversary dinner',       // within stay → kept
  ].join('\n');

  const out = filterNoteByStayWindow(note, '2026-05-27', '2026-05-30', TODAY);
  assert.ok(out.includes('Allergy: shellfish'));
  assert.ok(out.includes('anniversary dinner'));
  assert.ok(!out.includes('spilled wine'));
  assert.ok(!out.includes('early checkin'));
});

test('filterNoteByStayWindow — one-week grace buffer around the window', () => {
  // In-house stay 25 May–05 Jun; today 01 Jun. Buffer widens both window bounds
  // by 7 days (kept window [18 May .. 12 Jun]) and the today-cutoff to 25 May.
  const today = '2026-06-01';
  const note = [
    '10/05/26 long before checkin',   // > 1 week before checkin → dropped
    '28/05/26 passed a few days ago', // within a week before today → kept
    '20/05/26 passed last week',      // > 1 week before today → dropped
    '04/06/26 upcoming this stay',    // future, in window → kept
    '10/06/26 just after checkout',   // within a week after checkout → kept
    '14/06/26 long after checkout',   // > 1 week after checkout → dropped
  ].join('\n');

  const out = filterNoteByStayWindow(note, '2026-05-25', '2026-06-05', today);
  assert.ok(!out.includes('long before checkin'));
  assert.ok(out.includes('passed a few days ago'));
  assert.ok(!out.includes('passed last week'));
  assert.ok(out.includes('upcoming this stay'));
  assert.ok(out.includes('just after checkout'));
  assert.ok(!out.includes('long after checkout'));
});

test('tidyNotes — drops empty input', () => {
  assert.strictEqual(tidyNotes(null), null);
  assert.strictEqual(tidyNotes(''), null);
  assert.strictEqual(tidyNotes('   |   '), null);
});

test('tidyNotes — dedups repeated pieces case-insensitively, keeps order + tags', () => {
  const notes = '[PREF] Likes red wine | [IN HOUSE] Late checkout | [PREF] likes red wine';
  assert.strictEqual(tidyNotes(notes), '[PREF] Likes red wine | [IN HOUSE] Late checkout');
});

test('tidyNotes — caps total length on a piece boundary with ellipsis', () => {
  const piece = '[PREF] ' + 'x'.repeat(120);            // 127 chars
  const out = tidyNotes([piece, piece.replace(/x/g, 'y'), piece.replace(/x/g, 'z')].join(' | '));
  assert.ok(out.length <= 300);
  assert.ok(out.endsWith('…'));
  // Two 127-char pieces + ' | ' = 257 fits; a third would overflow 300.
  assert.ok(out.includes('xxx') && out.includes('yyy'));
  assert.ok(!out.includes('zzz'));
});

test('tidyNotes — hard-cuts a single oversized piece', () => {
  const out = tidyNotes('[GUESTPROF] ' + 'a'.repeat(500));
  assert.strictEqual(out.length, 300);
  assert.ok(out.endsWith('…'));
});

test('extractEstimatedTime — arrival times in various bilingual formats', () => {
  const arr = (t) => extractEstimatedTime(t, 'arrival');
  assert.strictEqual(arr('We will be landing at the airport at 3:15pm approximately.'), '15:15');
  assert.strictEqual(arr('Pedido de check-in: el período 13:00 - 14:00.'), '13:00');
  assert.strictEqual(arr('Llegan 17:30 - Nos avisó por mail'), '17:30');
  assert.strictEqual(arr('avisa que llega a las 11hs por su cuenta'), '11:00');
  assert.strictEqual(arr('Horario de llegada estimado Entre las 3:00 PM y las 4:00 PM'), '15:00');
  assert.strictEqual(arr('Check in 12pm Extra bed'), '12:00');
  assert.strictEqual(arr('Flight: LA 434 (Arrival 11:06 AM) - Vehicle'), '11:06');
  assert.strictEqual(arr('deben aterrizar en Mendoza en el vuelo Latam 8019 a las 12:00 hs.'), '12:00');
  assert.strictEqual(arr('Sábado 7.30 pm | ETA || Llegada a TVRS'), '19:30');
});

test('extractEstimatedTime — departure times', () => {
  const dep = (t) => extractEstimatedTime(t, 'departure');
  assert.strictEqual(dep('tienen el pick up para irse el dia 5 junio a las 7am.'), '07:00');
  assert.strictEqual(dep('9.45 h – saida do hotel'), '09:45');
  assert.strictEqual(dep('Tiene late check out confirmado a las 21hs para el 03 de junio'), '21:00');
});

test('extractEstimatedTime — ignores prices, flight numbers, and absent times', () => {
  // Currency-prefixed numbers must not read as times.
  assert.strictEqual(extractEstimatedTime('AR | USD 1.028.- FR&FF rate/ IVA Exento.-', 'arrival'), null);
  // No arrival/departure keyword near any time → null (conservative).
  assert.strictEqual(extractEstimatedTime('JETSMART SPA JA 3071 2:34pm', 'arrival'), null);
  assert.strictEqual(extractEstimatedTime('Likes red wine, no times here at all', 'arrival'), null);
  // Departure parser should not fire on an arrival-only note.
  assert.strictEqual(extractEstimatedTime('Llegan 17:30 - Nos avisó por mail', 'departure'), null);
});
