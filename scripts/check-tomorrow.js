#!/usr/bin/env node
/**
 * Quick check: who's checking in tomorrow with agent/invalid emails?
 */
'use strict';
require('dotenv').config();

const OracleClient = require('../src/oracle-client');
const { sanitizeEmail, isAgentEmail } = require('../src/guest-utils');

(async () => {
  const oc = new OracleClient({
    host: process.env.ORACLE_HOST, port: process.env.ORACLE_PORT || '1521',
    sid: process.env.ORACLE_SID, service: process.env.ORACLE_SERVICE,
    user: process.env.ORACLE_USER, password: process.env.ORACLE_PASSWORD
  });
  await oc.connect();

  const rows = await oc.query(`
    SELECT rn.NAME_ID, rn.BEGIN_DATE, rn.END_DATE, rn.RESV_STATUS,
           p.PHONE_NUMBER AS EMAIL, n.FIRST, n.LAST
    FROM OPERA.RESERVATION_NAME rn
    JOIN OPERA.NAME n ON rn.NAME_ID = n.NAME_ID
    JOIN OPERA.NAME_PHONE p ON rn.NAME_ID = p.NAME_ID
      AND p.PHONE_ROLE = 'EMAIL' AND p.PRIMARY_YN = 'Y'
    WHERE rn.RESORT = 'VINES'
      AND TRUNC(rn.BEGIN_DATE) = DATE '2026-02-27'
      AND rn.RESV_STATUS IN ('RESERVED','CHECKED IN')
  `);
  await oc.close();

  console.log(`\nGuests checking in 2026-02-27: ${rows.length}`);
  let agents = 0, invalid = 0, ok = 0;
  for (const r of rows) {
    const email = (r.EMAIL || '').trim();
    const clean = sanitizeEmail(email);
    if (!clean) {
      invalid++;
      console.log(`  INVALID: ${r.FIRST} ${r.LAST} <${email || '(empty)'}>`);
      continue;
    }
    const cat = isAgentEmail({ email: clean });
    if (cat) {
      agents++;
      console.log(`  AGENT:   ${r.FIRST} ${r.LAST} <${clean}> [${cat}]`);
      continue;
    }
    ok++;
  }
  console.log(`\nSummary: ${ok} ok, ${agents} agent, ${invalid} invalid`);
})();
