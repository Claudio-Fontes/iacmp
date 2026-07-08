import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { AIGeneratedResponse, writeGeneratedFiles, removeOrphanedGeneratedFiles } from '@iacmp/ai';

const ALLOWED_CONFIG_KEYS = new Set([
  'resourceGroup', 'region', 'accountTier', 'subscriptionId', 'tenantId', 'projectId', 'location',
]);

export function applyConfig(parsed: AIGeneratedResponse, cwd: string): void {
  if (!parsed.config || Object.keys(parsed.config).length === 0) return;
  const configPath = path.join(cwd, 'iacmp.json');
  if (!fs.existsSync(configPath)) return;
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return;
  }
  let changed = false;
  for (const [k, v] of Object.entries(parsed.config)) {
    if (!ALLOWED_CONFIG_KEYS.has(k)) continue;
    if (current[k] !== v) {
      current[k] = v;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n');
    const keys = Object.keys(parsed.config).filter(k => ALLOWED_CONFIG_KEYS.has(k));
    console.log(chalk.dim(`  iacmp.json atualizado: ${keys.join(', ')}`));
  }
}

export type AskFn = (question: string) => Promise<string>;

// Coleta todos os artefatos geráveis (stacks/**/*.ts e src/**/*.ts/.js) já
// presentes no projeto — usados como semente de `previouslyWritten` para que o
// reconcile remova stacks de SESSÕES ANTERIORES que não fazem parte da nova geração.
export function collectExistingGeneratedFiles(cwd: string): string[] {
  const result: string[] = [];
  for (const dir of ['stacks', 'src']) {
    const absDir = path.join(cwd, dir);
    if (!fs.existsSync(absDir)) continue;
    const scan = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          result.push(path.relative(cwd, full));
        }
      }
    };
    scan(absDir);
  }
  return result;
}

// Escreve a geração inicial e remove as stacks/handlers de SESSÕES ANTERIORES
// (preExistingGeneratedFiles) ausentes desta geração — senão `iacmp synth`
// carrega TODAS as .ts de stacks/ e falha com constructs duplicados/obsoletos.
// Retorna a lista do que foi escrito (base para o reconcile do loop de synth).
export async function persistInitial(
  parsed: AIGeneratedResponse,
  cwd: string,
  dryRun: boolean,
  ask: AskFn,
  preExistingGeneratedFiles: string[]
): Promise<string[]> {
  if (!dryRun) applyConfig(parsed, cwd);
  const previouslyWritten = await writeGeneratedFiles(parsed.files, cwd, dryRun, ask);
  if (!dryRun && preExistingGeneratedFiles.length > 0) {
    const staleOrphans = removeOrphanedGeneratedFiles(preExistingGeneratedFiles, parsed.files, cwd);
    if (staleOrphans.length > 0) {
      console.log(chalk.dim(`  ✗ removidos ${staleOrphans.length} arquivo(s) de sessões anteriores: ${staleOrphans.join(', ')}`));
    }
  }
  return previouslyWritten;
}

// Escreve a regeneração de uma tentativa de auto-correção e, SÓ se ela foi de
// fato aplicada, remove os órfãos da tentativa anterior — senão o synth (que
// carrega TODAS as .ts de stacks/) segue vendo constructs duplicados e não
// converge. Retorna a nova lista de escritos (ou a anterior, se nada foi escrito).
export async function rewriteAndReconcile(
  parsed: AIGeneratedResponse,
  cwd: string,
  previouslyWritten: string[]
): Promise<string[]> {
  applyConfig(parsed, cwd);
  const written = await writeGeneratedFiles(parsed.files, cwd, false, async () => 'y');
  if (written.length === 0) return previouslyWritten;
  const orphans = removeOrphanedGeneratedFiles(previouslyWritten, parsed.files, cwd);
  if (orphans.length > 0) {
    console.log(chalk.dim(`  ✗ removidos ${orphans.length} arquivo(s) órfão(s) da tentativa anterior: ${orphans.join(', ')}`));
  }
  return written;
}
