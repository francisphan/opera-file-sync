'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseLeadingDate, filterNoteByStayWindow } = require('../src/opera-db-query');

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
