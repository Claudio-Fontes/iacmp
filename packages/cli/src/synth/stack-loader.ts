import * as fs from 'fs';
import * as path from 'path';
import { Stack } from '@iacmp/core';
import { LoadedStack } from '../validators';
import { findStackFiles } from '../load-stacks';
import { SynthUI } from './types';

// Busca um módulo em node_modules do projeto e de diretórios pai (monorepo).
export function resolveModule(projectDir: string, moduleName: string): string | null {
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    const modPath = path.join(dir, 'node_modules', moduleName);
    if (fs.existsSync(modPath)) return modPath;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Carrega TODAS as stacks de stacks/ (ignora --stack de propósito).
 * A resolução de referências entre stacks (ex: Function.ApiGateway numa
 * stack referenciando Function.Lambda de outra) precisa de visão do
 * projeto inteiro, mesmo quando o usuário só quer sintetizar uma stack.
 */
export function loadProjectStacks(cwd: string, stacksDir: string, ui: SynthUI): LoadedStack[] {
  const allStackFiles = findStackFiles(stacksDir);
  const loadedStacks: LoadedStack[] = [];
  const loadErrors: string[] = [];
  // O nome de saída deriva do basename do arquivo — dois arquivos com o mesmo
  // basename em pastas diferentes sobrescreveriam o output um do outro em silêncio.
  const stackFilesByName = new Map<string, string[]>();

  for (const stackPath of allStackFiles) {
    const file = path.basename(stackPath);
    const stackName = file.replace(/\.(ts|js)$/, '');

    let stackModule: Record<string, unknown>;
    try {
      // .ts: registra tsx se disponível no projeto do usuário e carrega diretamente
      if (file.endsWith('.ts')) {
        const tsxPath = resolveModule(cwd, 'tsx');
        if (tsxPath) {
          const tsxApiPath = require.resolve('tsx/cjs/api', { paths: [cwd] });
          require(tsxApiPath).register();
        } else {
          ui.warn(`tsx não encontrado em ${cwd}/node_modules. Rode: npm install tsx`);
          continue;
        }
      }
      stackModule = require(stackPath) as Record<string, unknown>;
    } catch (err) {
      // Erro de compilação/sintaxe num stack é FALHA, não warning — antes o
      // arquivo sumia silenciosamente do output e o loop de validação da IA
      // achava que estava tudo certo (via "Synth validado" com exit 0).
      loadErrors.push(`${file}: ${(err as Error).message}`);
      continue;
    }

    const stack = stackModule.default ?? stackModule.stack ?? stackModule;
    if (!stack || typeof stack !== 'object' || !('constructs' in stack)) {
      ui.warn(`${file} não exporta uma Stack válida. Exporte a stack como default.`);
      continue;
    }

    loadedStacks.push({ stackName, stack: stack as Stack });
    const rel = path.relative(stacksDir, stackPath);
    stackFilesByName.set(stackName, [...(stackFilesByName.get(stackName) ?? []), rel]);
  }

  const collisions = [...stackFilesByName.entries()].filter(([, files]) => files.length > 1);
  if (collisions.length > 0) {
    ui.error(
      'Colisão de nome de stack — arquivos diferentes gerariam o MESMO arquivo de saída (um sobrescreveria o outro):\n\n' +
      collisions.map(([name, files]) => `  • "${name}": ${files.join('  ×  ')}`).join('\n') +
      '\n\nRenomeie os arquivos para basenames únicos (a pasta não diferencia o nome de saída).',
    );
  }

  if (loadErrors.length > 0) {
    ui.error(
      `Falha ao carregar ${loadErrors.length} stack(s) — corrija os erros de compilação:\n\n` +
      loadErrors.map(e => `  • ${e}`).join('\n'),
    );
  }

  if (loadedStacks.length === 0) {
    ui.error('Nenhuma stack encontrada em stacks/');
  }

  return loadedStacks;
}
