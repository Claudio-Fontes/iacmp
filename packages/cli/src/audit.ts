import * as fs from 'fs';
import * as path from 'path';
import { Stack } from '@iacmp/core';

export interface AuditConfig {
  name: string;
  provider: string;
}

export function readConfig(cwd: string): AuditConfig {
  const configPath = path.join(cwd, 'iacmp.json');
  if (!fs.existsSync(configPath)) throw new Error('iacmp.json não encontrado. Rode: iacmp init');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  return {
    name: (config.name as string) ?? path.basename(cwd),
    provider: (config.provider as string) ?? 'aws',
  };
}

function resolveTsNode(projectDir: string): string | null {
  const dirs: string[] = [];
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    const tsNodePath = path.join(d, 'node_modules', 'ts-node');
    if (fs.existsSync(tsNodePath)) return tsNodePath;
  }
  return null;
}

export function loadStacks(cwd: string): Array<{ name: string; stack: Stack }> {
  const stacksDir = path.join(cwd, 'stacks');
  if (!fs.existsSync(stacksDir)) throw new Error('Diretório stacks/ não encontrado.');

  const stackFiles = fs.readdirSync(stacksDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
  if (stackFiles.length === 0) throw new Error('Nenhuma stack encontrada em stacks/');

  const tsNodePath = resolveTsNode(cwd);
  if (tsNodePath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(tsNodePath).register({
      transpileOnly: true,
      skipProject: true,
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: false,
        skipLibCheck: true,
      },
    });
  }

  const result: Array<{ name: string; stack: Stack }> = [];
  for (const file of stackFiles) {
    const stackName = file.replace(/\.(ts|js)$/, '');
    const stackPath = path.join(stacksDir, file);
    try {
      const mod = require(stackPath) as Record<string, unknown>;
      const raw = mod.default ?? mod.stack ?? mod;
      if (!raw || typeof raw !== 'object' || !('constructs' in raw)) continue;
      result.push({ name: stackName, stack: raw as Stack });
    } catch {
      // silently skip invalid stacks
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
