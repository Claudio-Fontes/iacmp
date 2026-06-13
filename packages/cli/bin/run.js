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

// Intercepta `iacmp ai --chat` ANTES do oclif — executa chat.js diretamente
// evitando que o oclif destrua o stdin antes do processo filho iniciar
const argv = process.argv.slice(2);
const isChat = argv.includes('ai') && (argv.includes('--chat') || argv.includes('-chat'));

if (isChat) {
  const cp = require('child_process');
  const chatScript = path.resolve(__dirname, 'chat.js');

  // Detecta --provider / -p
  let provider = 'aws';
  const pIdx = argv.findIndex(a => a === '--provider' || a === '-p');
  if (pIdx !== -1 && argv[pIdx + 1]) provider = argv[pIdx + 1];

  // Detecta --dry-run
  const dryRun = argv.includes('--dry-run') ? '1' : '0';

  // Carrega iacmp.json do projeto para provider padrão
  try {
    const cfgPath = path.resolve(process.cwd(), 'iacmp.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.provider && provider === 'aws') provider = cfg.provider;
    }
  } catch {}

  const child = cp.spawn(process.execPath, [chatScript], {
    stdio: 'inherit',
    env: {
      ...process.env,
      IACMP_CWD: process.cwd(),
      IACMP_PROVIDER: provider,
      IACMP_DRYRUN: dryRun,
    },
  });

  child.on('close', code => process.exit(code || 0));
} else {
  // Garante que @iacmp/* seja sempre resolvido a partir do node_modules do CLI
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
  run(argv, __dirname).then(flush).catch(handle);
}
