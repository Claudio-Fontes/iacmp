import * as fs from 'fs';
import * as path from 'path';
import { Stack } from '@iacmp/core';
import { LoadedStack } from '../validators';
import { findStackFiles } from '../load-stacks';
import { SynthUI } from './types';
import { t } from '../i18n';

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
          ui.warn(t(`tsx não encontrado em ${cwd}/node_modules. Rode: npm install tsx`, `tsx not found in ${cwd}/node_modules. Run: npm install tsx`));
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
      ui.warn(t(`${file} não exporta uma Stack válida. Exporte a stack como default.`, `${file} does not export a valid Stack. Export the stack as default.`));
      continue;
    }

    loadedStacks.push({ stackName, stack: stack as Stack });
    const rel = path.relative(stacksDir, stackPath);
    stackFilesByName.set(stackName, [...(stackFilesByName.get(stackName) ?? []), rel]);
  }

  const collisions = [...stackFilesByName.entries()].filter(([, files]) => files.length > 1);
  if (collisions.length > 0) {
    ui.error(
      t(
        'Colisão de nome de stack — arquivos diferentes gerariam o MESMO arquivo de saída (um sobrescreveria o outro):\n\n',
        'Stack name collision — different files would generate the SAME output file (one would overwrite the other):\n\n',
      ) +
      collisions.map(([name, files]) => `  • "${name}": ${files.join('  ×  ')}`).join('\n') +
      t(
        '\n\nRenomeie os arquivos para basenames únicos (a pasta não diferencia o nome de saída).',
        '\n\nRename the files to unique basenames (the folder does not differentiate the output name).',
      ),
    );
  }

  if (loadErrors.length > 0) {
    ui.error(
      t(
        `Falha ao carregar ${loadErrors.length} stack(s) — corrija os erros de compilação:\n\n`,
        `Failed to load ${loadErrors.length} stack(s) — fix the compilation errors:\n\n`,
      ) +
      loadErrors.map(e => `  • ${e}`).join('\n'),
    );
  }

  if (loadedStacks.length === 0) {
    ui.error(t('Nenhuma stack encontrada em stacks/', 'No stacks found in stacks/'));
  }

  return loadedStacks;
}
