#!/usr/bin/env node
'use strict';
// Safe online backup of the donations database: npm run backup
const path = require('path');
const fs = require('fs');
const config = require('../src/config');
const Database = require('better-sqlite3');
const dir = path.join(path.dirname(config.databasePath), 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `donations-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
new Database(config.databasePath, { readonly: true }).backup(file).then(() => console.log('Backup saved:', file));
