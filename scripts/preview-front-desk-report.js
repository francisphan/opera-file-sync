#!/usr/bin/env node

/**
 * Render the daily front-desk report from sample data — no DB, no email.
 * Lets us iterate on the layout (print-friendliness, notes rendering) without
 * touching the OPERA box.
 *
 * Usage: node scripts/preview-front-desk-report.js [output.html]
 *        (defaults to stdout)
 */

process.env.EMAIL_ENABLED = process.env.EMAIL_ENABLED || 'false';

const fs = require('fs');
const Notifier = require('../src/notifier');

// Modeled on real report content (names invented): long scoped notes plus
// CASHIER comments are the case that used to balloon the printout.
const LONG_NOTES = '[HISTORY] PVO owner since 2019, prefers villa row 20s | [PALBE] Alérgico a las nueces, vino tinto seco preferido | [PREF] King bed, late checkout when possible | [CASHIER] MF | USD 660.- 3x2 rate.-/ IVA exento/ Tarifa prorrateada.- Room pre paga pax, extras paga pax al resort UPSELL: Cobrar U$ 675 al check out Cobrar resort Fee al OUT';
const MED_NOTES = '[PREF] Es alérgico a las nueces | [PALBE] Desayuno sin gluten | [CASHIER] AR | Comply rate, incluye desayuno';
const SHORT_NOTES = '[PREF] Espumante de aniversario + carta';

const g = (firstName, lastName, over = {}) => ({
  firstName,
  lastName,
  email: over.email ?? `${firstName}.${lastName}@example.com`.toLowerCase(),
  country: 'United States',
  language: 'English',
  villa: '020',
  adults: 2,
  children: 0,
  prs: '2/0',
  checkIn: '2026-07-04',
  checkOut: '2026-07-09',
  eta: null,
  etd: null,
  notes: null,
  ...over,
});

const sample = {
  date: '2026-07-06',
  inHouse: [
    g('Mansi', 'Babyloni', { villa: '015', notes: LONG_NOTES, companionNames: 'Shiven Khosla' }),
    g('Francis', 'Phan', { villa: '023', prs: '1/0', adults: 1, notes: MED_NOTES }),
    g('Aline', 'Vinhoti', { villa: '027', country: 'Brazil', notes: SHORT_NOTES, companionNames: 'Ademir Vinhoti' }),
    g('Daniela', 'Scheffer', { villa: '029', country: 'Brazil', language: 'Portuguese', notes: LONG_NOTES }),
    g('Eduardo', 'Aoun', { villa: '010', country: 'Brazil', notes: MED_NOTES, companionNames: 'Ana Luisa Bartholome' }),
  ],
  departures: [
    g('Dee', 'Parting', { checkOut: '2026-07-06', etd: '10:30', notes: SHORT_NOTES }),
  ],
  arrivalsToday: [
    g('Pat', 'Arriving', { checkIn: '2026-07-06', eta: '15:00', notes: MED_NOTES }),
    g('Ken', 'Landing', { checkIn: '2026-07-06', eta: null, notes: null }),
  ],
  arrivalsTomorrow: [
    g('Tom', 'Morrow', { checkIn: '2026-07-07', checkOut: '2026-07-12', eta: '12:00', notes: SHORT_NOTES }),
  ],
  arrivalsDayAfter: [
    g('Ada', 'Later', { checkIn: '2026-07-08', checkOut: '2026-07-11', eta: null, notes: LONG_NOTES }),
  ],
  postingMasters: [
    g('Grupo', 'Bodega Tour', { villa: '9041', notes: '[CASHIER] Cargos de restaurante del grupo' }),
  ],
};

const notifier = new Notifier();
const built = notifier.buildDailyFrontDeskReport(sample);
if (!built) {
  console.error('Nothing to render');
  process.exit(1);
}

const out = process.argv[2];
if (out) {
  fs.writeFileSync(out, built.htmlBody);
  console.error(`Wrote ${out} (${built.htmlBody.length} bytes)`);
} else {
  console.log(built.htmlBody);
}
