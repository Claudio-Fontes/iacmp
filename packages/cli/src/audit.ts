import * as fs from 'fs';
import * as path from 'path';
import { Stack, tsCompilerOptions } from '@iacmp/core';
import { readJsonFile, errMessage } from './utils';

export interface AuditConfig {
  name: string;
  provider: string;
}

export function readConfig(cwd: string): AuditConfig {
  const configPath = path.join(cwd, 'iacmp.json');
  if (!fs.existsSync(configPath)) throw new Error('iacmp.json não encontrado. Rode: iacmp init');
  const config = readJsonFile<Record<string, unknown>>(configPath);
  return {
    name: (config.name as string) ?? path.basename(cwd),
    provider: (config.provider as string) ?? 'aws',
  };
}

function resolveTsx(projectDir: string): string | null {
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'node_modules', 'tsx');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findStackFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findStackFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

export function loadStacks(cwd: string): Array<{ name: string; stack: Stack }> {
  const stacksDir = path.join(cwd, 'stacks');
  if (!fs.existsSync(stacksDir)) throw new Error('Diretório stacks/ não encontrado.');

  const stackFiles = findStackFiles(stacksDir);
  if (stackFiles.length === 0) throw new Error('Nenhuma stack encontrada em stacks/');

  const tsxPath = resolveTsx(cwd);
  if (tsxPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tsxApiPath = require.resolve('tsx/cjs/api', { paths: [cwd] });
    require(tsxApiPath).register();
  }

  const result: Array<{ name: string; stack: Stack }> = [];
  for (const stackPath of stackFiles) {
    const stackName = path.basename(stackPath).replace(/\.(ts|js)$/, '');
    try {
      const mod = require(stackPath) as Record<string, unknown>;
      const raw = mod.default ?? mod.stack ?? mod;
      if (!raw || typeof raw !== 'object' || !('constructs' in raw)) {
        console.warn(`[audit] ${path.basename(stackPath)} não exporta uma Stack válida — ignorado.`);
        continue;
      }
      result.push({ name: stackName, stack: raw as Stack });
    } catch (err) {
      console.warn(`[audit] falha ao carregar ${path.basename(stackPath)}: ${errMessage(err)}`);
    }
  }
  return result;
}

export function saveReport(cwd: string, commandName: string, content: string): string {
  const auditDir = path.join(cwd, 'audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const fileName = `${commandName}-${date}.md`;
  const filePath = path.join(auditDir, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  return path.join('audit', fileName);
}

export function today(): string {
  return new Date().toLocaleDateString('pt-BR');
}
