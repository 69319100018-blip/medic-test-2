'use strict';

/**
 * Local development entry point.
 * Loads local-only configuration, mounts the same API app used by Vercel,
 * and adds a restricted static-file host for the browser frontend.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const app = require('../api/index.js');
const publicRoot = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

// The API routes are registered by api/index.js before this middleware.
// Only unmatched paths reach this guard, which prevents source/config files
// from being exposed through the local static host.
app.use((req, res, next) => {
  const pathname = req.path.toLowerCase();

  if (/^\/(?:api|server-local|docs|tests|scripts|\.github)(?:\/|$)/i.test(pathname)) {
    return res.status(404).send('Not found');
  }

  if (
    /(?:^|\/)(?:package(?:-lock)?\.json|vercel\.json|schema\.sql|server\.js|\.env(?:\..*)?)$/i.test(pathname) ||
    /\.(?:md|sql|json)$/i.test(pathname) ||
    pathname.includes('/node_modules/') ||
    pathname.includes('/.git/')
  ) {
    return res.status(404).send('Not found');
  }

  next();
});

app.use(express.static(publicRoot, {
  dotfiles: 'deny',
  index: false,
  fallthrough: true,
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicRoot, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
  console.log(`Medic Shift Log local server listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
