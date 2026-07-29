#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const { homedir, platform } = require('os');
const { existsSync, readFileSync, appendFileSync, writeFileSync } = require('fs');
const path = require('path');


const LANG_PT = (process.env.IACMP_LANG || '').trim().toLowerCase().startsWith('pt');

const WELCOME = LANG_PT ? `
[iacmp] Instalado! Comece agora:

  iacmp init meu-projeto      # cria um projeto de exemplo pronto para deploy
  cd meu-projeto
  iacmp synth                 # gera CloudFormation/Bicep/Terraform + validações
  iacmp deploy --dry-run      # mostra o plano sem executar nada

  Claude Code: iacmp setup    # registra as ferramentas MCP do iacmp
  Docs: https://github.com/Claudio-Fontes/iacmp
` : `
[iacmp] Installed! Get started:

  iacmp init my-project       # scaffolds an example project ready to deploy
  cd my-project
  iacmp synth                 # generates CloudFormation/Bicep/Terraform + validations
  iacmp deploy --dry-run      # shows the plan without executing anything

  Claude Code: iacmp setup    # registers the iacmp MCP tools
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

// Uso IMEDIATO no terminal atual: o export no perfil só vale para novos
// shells. Se algum diretório do PATH da sessão for gravável, cria ali um
// symlink para o binário — o comando funciona sem abrir outro terminal.
function linkIntoCurrentPath() {
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
  if (pathDirs.includes(binDir)) return true; // já resolvível
  const src = path.join(binDir, 'iacmp');
  if (!existsSync(src)) return false;
  for (const dir of pathDirs) {
    if (dir.startsWith('/usr/') || dir.startsWith('/bin') || dir.startsWith('/sbin') || dir.startsWith('/System')) continue;
    try {
      const dest = path.join(dir, 'iacmp');
      try { require('fs').unlinkSync(dest); } catch {}
      require('fs').symlinkSync(src, dest);
      console.log(LANG_PT ? `[iacmp] Atalho criado: ${dest}` : `[iacmp] Shortcut created: ${dest}`);
      return true;
    } catch { /* dir não gravável — tenta o próximo */ }
  }
  return false;
}
const immediatelyUsable = linkIntoCurrentPath();

if (alreadyConfigured) {
  if (!immediatelyUsable) {
    console.log(LANG_PT
      ? '[iacmp] Abra um novo terminal para o comando "iacmp" ficar disponível.'
      : '[iacmp] Open a new terminal for the "iacmp" command to become available.');
  }
  console.log(WELCOME);
  process.exit(0);
}

// Adicionar ao primeiro arquivo que existir; se nenhum existir, criar .zprofile
const target = candidates.find(f => existsSync(f)) || path.join(home, '.zprofile');

try {
  if (!existsSync(target)) {
    writeFileSync(target, `${exportLine}\n`);
  } else {
    appendFileSync(target, `\n${exportLine}\n`);
  }
  console.log(LANG_PT ? `\n[iacmp] Adicionado ${binDir} ao PATH em: ${target}` : `\n[iacmp] Added ${binDir} to PATH in: ${target}`);
  console.log(LANG_PT ? `[iacmp] Abra um novo terminal ou rode: source ${target}` : `[iacmp] Open a new terminal or run: source ${target}`);
  console.log(WELCOME);
} catch {
  console.log(LANG_PT ? `\n[iacmp] Adicione ao seu shell config:\n  ${exportLine}` : `\n[iacmp] Add this to your shell config:\n  ${exportLine}`);
  console.log(WELCOME);
}
