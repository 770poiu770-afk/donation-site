'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LANGS = ['en', 'he'];
const dict = {};
for (const l of LANGS) dict[l] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${l}.json`), 'utf8'));

function lookup(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function translator(lang) {
  return (key, vars = {}) => {
    let s = lookup(dict[lang], key) ?? lookup(dict.en, key) ?? key;
    if (typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
    return s;
  };
}

/** Site content (org texts) for a language with English fallback */
function content(lang) {
  const c = config.site.content || {};
  return { ...(c.en || {}), ...(c[lang] || {}) };
}

function middleware(req, res, next) {
  let lang = req.query.lang;
  if (LANGS.includes(lang)) {
    res.cookie('lang', lang, { maxAge: 365 * 864e5, sameSite: 'lax', secure: config.isProduction });
  } else {
    lang = req.cookies?.lang;
    if (!LANGS.includes(lang)) lang = config.site.defaultLang || (req.acceptsLanguages('he', 'en') === 'he' ? 'he' : 'en');
  }
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.dir = lang === 'he' ? 'rtl' : 'ltr';
  res.locals.t = translator(lang);
  res.locals.c = content(lang);
  res.locals.org = config.site.org;
  res.locals.site = config.site;
  res.locals.orgName = config.site.org.name?.[lang] || config.site.org.name?.en;
  res.locals.otherLang = lang === 'he' ? 'en' : 'he';
  const params = new URLSearchParams(req.query);
  params.set('lang', res.locals.otherLang);
  res.locals.langHref = `${req.path}?${params.toString()}`;
  next();
}

module.exports = { middleware, translator, content, LANGS };
