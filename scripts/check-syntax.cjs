#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const roots = ['api', 'server-local', 'js'];
const esm = new Set(['api/doctors.js','api/fund.js','api/shift.js','api/stock.js','api/vehicle.js']);
function collect(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs,{withFileTypes:true}).flatMap((entry) => {
    const rel = path.posix.join(dir,entry.name);
    if (entry.isDirectory()) return collect(rel);
    return entry.isFile() && rel.endsWith('.js') ? [rel] : [];
  });
}
const files = [...roots.flatMap(collect),'scripts/check-syntax.cjs','tests/api-smoke.test.cjs']
  .filter((file) => fs.existsSync(path.join(root,file)));
let failed = 0;
for (const rel of files) {
  const abs = path.join(root,rel);
  const moduleMode = esm.has(rel);
  const result = spawnSync(process.execPath,moduleMode ? ['--input-type=module','--check'] : ['--check',abs],{
    cwd:root,encoding:'utf8',input:moduleMode ? fs.readFileSync(abs,'utf8') : undefined
  });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(`\n[syntax] ${rel}\n${result.stderr || result.stdout || 'Syntax check failed'}\n`);
  } else process.stdout.write(`[ok] ${rel}\n`);
}
if (failed) {
  process.stderr.write(`\n${failed} JavaScript file(s) failed syntax validation.\n`);
  process.exitCode = 1;
} else process.stdout.write(`\nValidated ${files.length} JavaScript file(s).\n`);
