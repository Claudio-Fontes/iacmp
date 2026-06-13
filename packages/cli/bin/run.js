#!/usr/bin/env node

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
