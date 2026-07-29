#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const { homedir, platform } = require('os');
const { existsSync, readFileSync, appendFileSync, writeFileSync } = require('fs');
const path = require('path');


const WELCOME = `
[iacmp] Instalado! Comece agora:

  iacmp init meu-projeto      # cria um projeto de exemplo pronto para deploy
  cd meu-projeto
  iacmp synth                 # gera CloudFormation/Bicep/Terraform + validações
  iacmp deploy --dry-run      # mostra o plano sem executar nada

  Claude Code: iacmp setup    # registra as ferramentas MCP do iacmp
  Docs: https://github.com/Claudio-Fontes/iacmp
`;
// Windows gerencia PATH via instalador — não mexer
if (platform() === 'win32') { console.log(WELCOME); process.exit(0); }

// Descobrir onde o npm instalou os binários globais
let binDir;
try {
  const prefix = execSync('npm config get prefix', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  binDir = path.join(prefix, 'bin');
} catch {
  console.log(WELCOME);
  process.exit(0);
}

const home = homedir();
const exportLine = `export PATH="${binDir}:$PATH"  # adicionado pelo iacmp`;

// Candidatos em ordem de preferência (zprofile = login shells no macOS)
const candidates = ['.zprofile', '.zshrc', '.bash_profile', '.bashrc']
  .map(f => path.join(home, f));

// Verificar se o binDir já aparece em ALGUM dos arquivos de config do shell.
// Não usamos process.env.PATH porque o npm injeta o bin no PATH antes de rodar
// este script — a variável sempre incluiria o binDir, mesmo que o shell do
// usuário não o tenha.
const alreadyConfigured = candidates.some(cfg => {
  try { return readFileSync(cfg, 'utf8').includes(binDir); }
  catch { return false; }
});

if (alreadyConfigured) { console.log(WELCOME); process.exit(0); }

// Adicionar ao primeiro arquivo que existir; se nenhum existir, criar .zprofile
const target = candidates.find(f => existsSync(f)) || path.join(home, '.zprofile');

try {
  if (!existsSync(target)) {
    writeFileSync(target, `${exportLine}\n`);
  } else {
    appendFileSync(target, `\n${exportLine}\n`);
  }
  console.log(`\n[iacmp] Adicionado ${binDir} ao PATH em: ${target}`);
  console.log(`[iacmp] Abra um novo terminal ou rode: source ${target}`);
  console.log(WELCOME);
} catch {
  console.log(`\n[iacmp] Adicione ao seu shell config:\n  ${exportLine}`);
  console.log(WELCOME);
}
