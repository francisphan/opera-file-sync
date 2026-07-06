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

// Modeled on real report content (names invented): long CASHIER/RESERVATION
// notes are the case that used to balloon the printout.
const LONG_NOTES = '[GEXPER] 18-05-26 Alfajores de maicena + carta de bienvenida OK Amenidad de aniversario + carta | [CASHIER] MF | USD 660.- 3x2 rate.-/ IVA exento/ Tarifa prorrateada.- Room pre paga pax, extras paga pax al resort UPSELL: TARIFA 3x2 CON DESCUENTO. Cobrar U$ 675 al check out Cobrar resort Fee al OUT | [RESERVATION] MF | KING | Consultó por la tasting en Vines To Go, le ofrecimos horarios y también enviamos WL pero no tuvimos respuesta | [Alert Check-Out] Cobrar U$ 675 al out por upsell Y FACTURAR EN VENTANA VACÍA';
const MED_NOTES = '[PREF] Es alérgico a las nueces | [CASHIER] AR | Comply rate, incluye desayuno | [RESERVATION] AR | KING | [Alert Check-Out] Le prestamos el pen drive rojo y negro';
const SHORT_NOTES = '[GEXPER] Espumante de aniversario + carta | [CASHIER] AR | USD 1.040,85.- BARBKF rate via Expedia/ IVA Exento/ Confidencial/ Garden View';

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
  badEmails: [
    g('Laura', 'Barreto', { email: '', reason: 'no email', villa: '019', companionNames: 'Drausio Barreto' }),
    g('Diego', 'Cieri', { email: 'diego@empresa.com.ar', reason: 'domain-unreachable', villa: '029', companionNames: 'Lucia Muñoz' }),
    g('Sonya', 'Ruparelia', { email: 'x@guest.booking.com', reason: 'booking-proxy', villa: null }),
  ],
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
  postingMasters: [
    g('Grupo', 'Bodega Tour', { villa: '9041', notes: '[RESERVATION] Cargos de restaurante del grupo' }),
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
