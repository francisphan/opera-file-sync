/**
 * Villa Number Map — translates OPERA room numbers to the physical number
 * painted on each villa/residence.
 *
 * Background: OPERA was renumbered in place (the "Cambio de Numeracion" project),
 * so the system now stores the NEW number (e.g. "025") while the building signage
 * still shows the OLD/physical number (e.g. "17"). OPERA does not store the old
 * number anywhere, so the only source of truth is the renumbering Google Sheet.
 *
 * Andes Condor Villas are signed "AC <n>" using the OPERA number (e.g. OPERA
 * 012 -> "AC 12"); all other villas render as "<physical> → <OPERA>" (e.g.
 * OPERA 025 -> "17 → 025"). That block is signed differently from the rest.
 *
 * Strategy (per ops request): cache the mapping locally and refresh weekly.
 *   - A built-in SEED ships with the code so the map works on first run / offline.
 *   - load() merges a local cache file (villa-map.json) over the seed at startup.
 *   - refresh() re-fetches Sheet1 of the renumbering sheet (col G = OPERA #,
 *     col C = physical #, col F = room-type code) and rewrites the cache. On any
 *     failure it keeps the existing map — the report never blocks on the sheet.
 *
 * Uses the shared Gmail OAuth credentials (same as notifier.js / sheets-client.js)
 * via raw axios, to stay pkg-bundle friendly.
 */

const fs = require('fs');
const axios = require('axios');
const logger = require('./logger');
const { dataPath } = require('./data-dir');

// Writable cache file, anchored next to the .exe when pkg-bundled
// (shared resolution with sync-state.json / daily-stats.json).
const CACHE_FILE = dataPath('villa-map.json');

// "The Vines Resort & Spa - Cambio de Numeracion" spreadsheet.
const DEFAULT_SHEET_ID = '188F7zx8YXxBJTmO9Hxx_F_58tfrnY82GtZzvLFLGalE';
const SHEET_RANGE = "'Sheet1'!A2:G45";

// Room-type code (sheet col F / OPERA category) that gets the "AC" signage prefix.
const ANDES_CONDOR_CODE = 'ACV';

// OPERA number (new, zero-padded 3-digit) -> physical/old number.
// Source: renumbering sheet, Sheet1 (col G -> col C), captured 2026-05-26.
const SEED_PHYS = {
  '014': '1',  '015': '3',  '016': '4',  '017': '5',  '018': '7',  '019': '9',
  '020': '10', '021': '11', '022': '14', '023': '15', '024': '16', '025': '17',
  '026': '18', '027': '19', '028': '20', '029': '21', '030': '22', '031': '23',
  '032': '24', '033': '26', '034': '28', '035': '30',
  '012': '31', '011': '32', '010': '33', '009': '34', '008': '35', '007': '36',
  '006': '37', '005': '38', '004': '39', '003': '40', '002': '41', '001': '42',
};
// Andes Condor Villas (OPERA 001-012) — physical numbers get the "AC" prefix.
const SEED_ACV = new Set(['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);

// Baked-in seed as { operaNum: { phys, prefix } }.
const SEED = Object.fromEntries(
  Object.entries(SEED_PHYS).map(([opera, phys]) => [opera, { phys, prefix: SEED_ACV.has(opera) ? 'AC' : '' }])
);

let map = { ...SEED };

/**
 * Normalize an OPERA room to its stored 3-digit zero-padded form ("25" -> "025").
 * Non-numeric rooms (none currently exist for villas) pass through unchanged.
 */
function normalizeRoom(room) {
  const s = String(room == null ? '' : room).trim();
  return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
}

/**
 * Coerce a map entry to { phys, prefix }, tolerating a legacy string-only cache.
 */
function toEntry(value) {
  if (value && typeof value === 'object' && value.phys) return { phys: String(value.phys), prefix: value.prefix || '' };
  if (typeof value === 'string' && value) return { phys: value, prefix: '' };
  return null;
}

/**
 * Render a room for display when mapped, else the raw room number unchanged
 * (e.g. residences 100-104, or any room not yet in the sheet). Falsy input
 * passes through so callers keep their own "—"/"" fallback.
 *
 *   - Andes Condor Villas are signed "AC <n>" using the OPERA number, e.g.
 *     OPERA 012 -> "AC 12".
 *   - All other villas: "<physical> -> <OPERA>", e.g. OPERA 025 -> "17 → 025".
 */
function formatVilla(room) {
  if (!room) return room;
  const norm = normalizeRoom(room);
  const entry = map[norm];
  if (!entry) return room;
  if (entry.prefix === 'AC') {
    const n = /^\d+$/.test(norm) ? parseInt(norm, 10) : norm;
    return `AC ${n}`;
  }
  return `${entry.phys} → ${room}`;
}

/**
 * Numeric sort key for ordering report rows "by villa number" the way front
 * desk reads them. Mapped villas sort by their physical/old number (1-42, which
 * front desk uses day to day — regular villas land at 1-30, Andes Condor at
 * 31-42, so the two bands don't collide). Unmapped numeric rooms (e.g. 100-series
 * residences) sort after all mapped villas; blank/non-numeric rooms sort last.
 */
function villaSortKey(room) {
  if (!room) return Number.POSITIVE_INFINITY;
  const norm = normalizeRoom(room);
  const entry = map[norm];
  if (entry && /^\d+$/.test(String(entry.phys))) return parseInt(entry.phys, 10);
  if (/^\d+$/.test(norm)) return parseInt(norm, 10) + 100000; // unmapped numeric — after mapped villas
  return Number.POSITIVE_INFINITY; // non-numeric / unknown — last
}

/**
 * Sorted list of the current OPERA villa numbers the map knows about (seed +
 * any cache/sheet entries merged in). This is the canonical "all villas" set —
 * it excludes residences (100-series), Posting Masters, and legacy/old numbers,
 * which never enter the map.
 */
function knownVillas() {
  return Object.keys(map).sort();
}

/** Load the cache file over the seed (called once at startup). */
function load() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && typeof cached === 'object') {
        const merged = { ...SEED };
        let n = 0;
        for (const [opera, value] of Object.entries(cached)) {
          const entry = toEntry(value);
          if (entry) { merged[opera] = entry; n++; }
        }
        if (n > 0) {
          map = merged;
          logger.info(`Villa map: loaded ${n} cached entries from ${CACHE_FILE}`);
          return;
        }
      }
    }
  } catch (err) {
    logger.warn(`Villa map: could not read cache ${CACHE_FILE} — using built-in seed (${err.message})`);
  }
  logger.info(`Villa map: using built-in seed (${Object.keys(SEED).length} entries)`);
}

/**
 * Re-fetch the mapping from the renumbering sheet and rewrite the cache.
 * Non-fatal: any error leaves the in-memory map and cache untouched.
 */
async function refresh(sheetId = process.env.VILLA_MAP_SHEET_ID || DEFAULT_SHEET_ID) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    logger.info('Villa map: no Gmail OAuth credentials — skipping sheet refresh, using cached/seed map');
    return;
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }, { timeout: 15000 });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(SHEET_RANGE)}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      timeout: 30000,
    });

    const fresh = {};
    for (const row of (res.data.values || [])) {
      const oldNum = String(row[2] || '').trim();           // col C — physical / old number
      const typeCode = String(row[5] || '').trim().toUpperCase(); // col F — room-type code
      const newNum = String(row[6] || '').trim();           // col G — OPERA / new number
      if (/^\d{1,3}$/.test(newNum) && /^\d{1,3}$/.test(oldNum)) {
        fresh[newNum.padStart(3, '0')] = {
          phys: String(parseInt(oldNum, 10)),
          prefix: typeCode === ANDES_CONDOR_CODE ? 'AC' : '',
        };
      }
    }

    if (Object.keys(fresh).length === 0) {
      logger.warn('Villa map refresh: sheet returned no usable rows — keeping existing map');
      return;
    }

    map = { ...SEED, ...fresh };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(fresh, null, 2));
    logger.info(`Villa map: refreshed ${Object.keys(fresh).length} entries from sheet → ${CACHE_FILE}`);
  } catch (err) {
    const status = err.response?.status;
    logger.warn(`Villa map refresh failed${status ? ` (HTTP ${status})` : ''} — keeping cached map: ${err.message}`);
  }
}

module.exports = { formatVilla, villaSortKey, knownVillas, load, refresh, normalizeRoom, _SEED: SEED };
