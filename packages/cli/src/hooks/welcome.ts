import { Hook } from '@oclif/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { t } from '../i18n';

/**
 * Banner de PRIMEIRA execução — o canal confiável do onboarding.
 *
 * O npm moderno silencia o stdout do postinstall (o "Comece agora" de lá só
 * aparece com --foreground-scripts), então o cliente instalava e não via
 * NENHUMA orientação — em especial o `iacmp setup` do Claude Code. Este hook
 * roda uma única vez (marcador em ~/.iacmp/welcomed), apenas em terminal
 * interativo, e NUNCA no `iacmp mcp serve` (o stdout ali é o protocolo MCP).
 */
const hook: Hook<'init'> = async function (opts) {
  try {
    if (!process.stdout.isTTY) return;
    const id = opts.id ?? '';
    if (id.startsWith('mcp')) return;

    const markerDir = path.join(os.homedir(), '.iacmp');
    const marker = path.join(markerDir, 'welcomed');
    if (fs.existsSync(marker)) return;
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());

    const line = chalk.dim('─'.repeat(64));
    console.log('');
    console.log(line);
    console.log(chalk.cyan.bold(t('  Bem-vindo ao iacmp — um código, três nuvens.', '  Welcome to iacmp — one codebase, three clouds.')));
    console.log('');
    console.log('  ' + chalk.green(t('iacmp init meu-projeto', 'iacmp init my-project')) + chalk.dim(t('   # projeto de exemplo pronto para deploy', '   # example project ready to deploy')));
    console.log('  ' + chalk.yellow.bold(t('⚡ Claude Code: rode `iacmp setup` para o agente gerar e operar sua infra', '⚡ Claude Code: run `iacmp setup` so the agent can generate and operate your infra')));
    console.log('  ' + chalk.dim(t('Idioma: export IACMP_LANG=pt · Docs: https://claudio-fontes.github.io/iacmp/pt/', 'Language: export IACMP_LANG=pt · Docs: https://claudio-fontes.github.io/iacmp')));
    console.log(line);
    console.log('');
  } catch { /* onboarding nunca pode quebrar um comando */ }
};

export default hook;
