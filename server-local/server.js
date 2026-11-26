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
const defaultPort = process.env.PORT ? Number(process.env.PORT) : 3000;

// The API routes are registered by api/index.js before this middleware.
// Only unmatched paths reach this guard; source and configuration directories
// are never exposed through the local static host.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'self'; script-src 'self' https://cdn.jsdelivr.net; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self'; media-src 'self' data: blob: https:; worker-src 'self' blob:");
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
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-store');
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

function createLocalServer({ port = defaultPort, host } = {}) {
  return host ? app.listen(port, host) : app.listen(port);
}

if (require.main === module) {
  const server = createLocalServer();
  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : defaultPort;
    console.log(`Medic Shift Log local server listening on http://localhost:${port}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { app, createLocalServer };
