#!/usr/bin/env node
'use strict';
// Runs the site locally with a built-in imitation of PayPal (no real payments, no credentials needed).
process.env.PAYPAL_MODE = 'mock';
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = process.env.DATABASE_PATH || require('path').join(__dirname, '..', 'data', 'demo.db');
process.env.BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
if (!process.env.ADMIN_PASSWORD_HASH) {
  // demo admin login: admin / demo-password-123
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('demo-password-123', 10);
  console.log('Demo admin login → user: admin  password: demo-password-123');
}
require('../server');
