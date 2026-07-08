import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import * as DiffLib from 'diff';
import { AWSProvider } from '@iacmp/provider-aws';
import { AzureProvider } from '@iacmp/provider-azure';
import { GCPProvider } from '@iacmp/provider-gcp';
import { TerraformProvider } from '@iacmp/provider-terraform';
import { Stack } from '@iacmp/core';
import { resolveTemplateDir, templateExt } from '../synth-out';
import { findStackFiles } from '../load-stacks';
import { readJsonFile, errMessage } from '../utils';

const CONTEXT_LINES = 2;

function renderDiff(oldText: string, newText: string): boolean {
  const changes = DiffLib.diffLines(oldText, newText);
  let hasChanges = false;
  const buffer: Array<{ type: 'add' | 'remove' | 'same'; line: string }> = [];

  for (const change of changes) {
    const lines = change.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    for (const line of lines) {
      if (change.added) {
        buffer.push({ type: 'add', line });
        hasChanges = true;
      } else if (change.removed) {
        buffer.push({ type: 'remove', line });
        hasChanges = true;
      } else {
        buffer.push({ type: 'same', line });
      }
    }
  }

  if (!hasChanges) return false;

  const changedIndexes = new Set<number>();
  buffer.forEach((entry, i) => {
    if (entry.type !== 'same') {
      for (let c = Math.max(0, i - CONTEXT_LINES); c <= Math.min(buffer.length - 1, i + CONTEXT_LINES); c++) {
        changedIndexes.add(c);
      }
    }
  });

  let lastPrinted = -1;
  for (let i = 0; i < buffer.length; i++) {
    if (!changedIndexes.has(i)) continue;
    if (lastPrinted !== -1 && i > lastPrinted + 1) {
      process.stdout.write(chalk.dim('...\n'));
    }
    const { type, line } = buffer[i];
    if (type === 'add') {
      process.stdout.write(chalk.green(`+ ${line}\n`));
    } else if (type === 'remove') {
      process.stdout.write(chalk.red(`- ${line}\n`));
    } else {
      process.stdout.write(`  ${line}\n`);
    }
    lastPrinted = i;
  }

  return true;
}

// Deve reproduzir EXATAMENTE o que `synth` grava em disco, senão o diff acusa
// uma mudança fantasma (ex.: synth grava JSON com '\n' final). Ver synth.ts.
function synthStack(stack: Stack, provider: string, allStacks: Stack[], projectName?: string): string {
  switch (provider) {
    case 'aws': {
      const p = new AWSProvider();
      return JSON.stringify(p.synthesize(stack, allStacks, undefined, projectName || undefined), null, 2) + '\n';
    }
    case 'azure': {
      const p = new AzureProvider();
      return p.synthesize(stack);
    }
    case 'gcp': {
      const p = new GCPProvider();
      return p.synthesize(stack);
    }
    case 'terraform': {
      const p = new TerraformProvider();
      return p.synthesize(stack);
    }
    default:
      throw new Error(`Provider '${provider}' não suportado.`);
  }
}

export default class Diff extends Command {
  static description = 'Compara o último synth salvo com o synth atual';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform)' }),
    stack: Flags.string({ char: 's', description: 'Stack específica' }),
  };

  static examples = [
    '$ iacmp diff',
    '$ iacmp diff --provider aws',
    '$ iacmp diff --stack minha-stack',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Diff);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    let config: { provider?: string; name?: string };
    try {
      config = readJsonFile<{ provider?: string; name?: string }>(configPath);
    } catch (err) {
      this.error(errMessage(err));
    }
    const provider = flags.provider ?? config.provider ?? 'aws';
    const outDir = resolveTemplateDir(cwd, provider);

    if (!outDir) {
      this.log('Nenhum synth anterior encontrado. Rode: iacmp synth');
      return;
    }

    const ext = templateExt(provider);
    const existingFiles = fs.readdirSync(outDir).filter(f => f.endsWith(ext));

    if (existingFiles.length === 0) {
      this.log('Nenhum synth anterior encontrado. Rode: iacmp synth');
      return;
    }

    const stacksDir = path.join(cwd, 'stacks');
    if (!fs.existsSync(stacksDir)) {
      this.error('Diretório stacks/ não encontrado.');
    }

    const stackFiles = findStackFiles(stacksDir)
      .filter(f => !flags.stack || path.basename(f).replace(/\.(ts|js)$/, '') === flags.stack);

    if (stackFiles.length === 0) {
      this.error('Nenhuma stack encontrada em stacks/');
    }

    // Carrega todos os stacks antes de sintetizar para que cross-stack refs resolvam
    const loadedStacks: { stackPath: string; stack: Stack }[] = [];
    for (const stackPath of stackFiles) {
      const file = path.basename(stackPath);
      let stackModule: Record<string, unknown>;
      try {
        stackModule = require(stackPath) as Record<string, unknown>;
      } catch (err) {
        this.warn(`Não foi possível carregar ${file}: ${errMessage(err)}`);
        continue;
      }
      const stack = stackModule.default ?? stackModule.stack ?? stackModule;
      if (!stack || typeof stack !== 'object' || !('constructs' in stack)) {
        this.warn(`${file} não exporta uma Stack válida.`);
        continue;
      }
      loadedStacks.push({ stackPath, stack: stack as Stack });
    }

    const allStacks = loadedStacks.map(s => s.stack);
    let anyDiff = false;

    for (const { stackPath, stack } of loadedStacks) {
      const file = path.basename(stackPath);
      const stackName = file.replace(/\.(ts|js)$/, '');
      const savedPath = path.join(outDir, `${stackName}${ext}`);

      if (!fs.existsSync(savedPath)) {
        this.log(`Stack nova (sem synth anterior): ${stackName}`);
        anyDiff = true;
        continue;
      }

      const oldText = fs.readFileSync(savedPath, 'utf-8');
      let newText: string;
      try {
        newText = synthStack(stack, provider, allStacks, config.name);
      } catch (err) {
        this.warn(`Erro ao sintetizar ${stackName}: ${errMessage(err)}`);
        continue;
      }

      this.log(`\n${chalk.bold(stackName)}${ext}`);
      this.log(chalk.dim('─'.repeat(50)));

      const hasDiff = renderDiff(oldText, newText);
      if (hasDiff) {
        anyDiff = true;
      } else {
        this.log(chalk.dim('  (sem alterações)'));
      }
    }

    if (!anyDiff) {
      this.log('\nNenhuma alteração detectada.');
    }
  }
}
