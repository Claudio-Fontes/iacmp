#!/usr/bin/env node

// Carrega .env do projeto do usuário sem depender de dotenvx
const path = require('path');
const fs = require('fs');
(function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = val;
  }
})();

// Garante que @iacmp/* seja sempre resolvido a partir do node_modules do CLI,
// independente de onde o usuário executa o comando.
const Module = require('module');
const _orig = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (req, parent, isMain, opts) {
  if (req.startsWith('@iacmp/')) {
    try { return _orig(req, parent, isMain, opts); } catch {}
    return _orig(req, module, isMain, opts);
  }
  return _orig(req, parent, isMain, opts);
};


const { run, handle, flush } = require('@oclif/core');

run(process.argv.slice(2), __dirname)
  .then(flush)
  .catch(handle);
