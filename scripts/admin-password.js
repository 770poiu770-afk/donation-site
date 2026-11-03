#!/usr/bin/env node
'use strict';
// Creates a bcrypt hash for the admin password. Put the output in ADMIN_PASSWORD_HASH.
const bcrypt = require('bcryptjs');
const readline = require('readline');

async function ask(q, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  return new Promise((res) => rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); }));
}

(async () => {
  const pw = process.argv[2] || (await ask('Admin password (min 12 chars): ', true));
  if (!pw || pw.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
  const hash = bcrypt.hashSync(pw, 12);
  console.log('\nAdd this line to your .env file (keep the single quotes):\n');
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
  console.log(`SESSION_SECRET=${require('crypto').randomBytes(32).toString('hex')}\n`);
})();
