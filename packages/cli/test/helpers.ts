import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Harness de testes black-box do CLI: roda o binário REAL (bin/run.js, que usa
 * o dist bundlado) dentro de um projeto temporário e captura stdout/stderr/exit.
 * É a forma mais fiel de testar um CLI — exercita oclif, carregamento de stacks,
 * providers e o pipeline synth-out de ponta a ponta, sem mockar a máquina do oclif.
 *
 * Stacks são geradas em .js (require('@iacmp/core')) para não depender de ts-node:
 * o CLI resolve @iacmp/core via o patch de Module em bin/run.js.
 */
export const CLI_BIN = path.resolve(__dirname, '..', 'bin', 'run.js');

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
  /** stdout + stderr concatenados, para asserts de conveniência. */
  all: string;
}

export function runCli(args: string[], opts: { cwd: string; input?: string }): RunResult {
  try {
    const stdout = execFileSync('node', [CLI_BIN, ...args], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      input: opts.input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, stderr: '', status: 0, all: stdout };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = err.stdout?.toString() ?? '';
    const stderr = err.stderr?.toString() ?? '';
    return {
      stdout,
      stderr,
      status: typeof err.status === 'number' ? err.status : 1,
      all: stdout + stderr,
    };
  }
}

export interface TempProjectOptions {
  provider?: string;
  /** filename (relativo a stacks/) -> conteúdo. Default: uma stack VPC+Bucket. */
  stacks?: Record<string, string>;
  iacmpJson?: Record<string, unknown>;
  /** Se true, NÃO cria stacks/ (para testar erros). */
  noStacks?: boolean;
  /** Se true, NÃO cria iacmp.json (para testar "projeto não inicializado"). */
  noConfig?: boolean;
}

export function makeProject(opts: TempProjectOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-cli-'));
  const provider = opts.provider ?? 'aws';

  if (!opts.noConfig) {
    const cfg = opts.iacmpJson ?? { name: 'test', provider, region: 'us-east-1', language: 'typescript' };
    fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify(cfg, null, 2) + '\n');
  }

  if (!opts.noStacks) {
    const stacksDir = path.join(dir, 'stacks');
    fs.mkdirSync(stacksDir, { recursive: true });
    const stacks = opts.stacks ?? { 'main-stack.js': defaultStackJs('main-stack') };
    for (const [name, content] of Object.entries(stacks)) {
      const p = path.join(stacksDir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }

  return dir;
}

/** Stack em .js (sem ts-node) com VPC + Bucket. */
export function defaultStackJs(name = 'main-stack'): string {
  return `const { Stack, Network, Storage } = require('@iacmp/core');
const stack = new Stack('${name}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
module.exports = stack;
`;
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), 'utf-8');
}

export function exists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel));
}

export function ls(dir: string, rel = '.'): string[] {
  try {
    return fs.readdirSync(path.join(dir, rel));
  } catch {
    return [];
  }
}
