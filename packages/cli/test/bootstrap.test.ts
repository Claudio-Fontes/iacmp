import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureProjectInitialized } from '../src/bootstrap';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-bootstrap-'));
}

function read(dir: string, rel: string) {
  return fs.readFileSync(path.join(dir, rel), 'utf-8');
}

describe('ensureProjectInitialized', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('pasta vazia → cria iacmp.json, tsconfig, package.json e .gitignore', () => {
    dir = makeTmpDir();
    const r = ensureProjectInitialized(dir, { installDeps: false });

    expect(r.bootstrapped).toBe(true);
    expect(fs.existsSync(path.join(dir, 'iacmp.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true);
  });

  test('iacmp.json tem accountTier free e provider correto', () => {
    dir = makeTmpDir();
    ensureProjectInitialized(dir, { provider: 'aws', installDeps: false });

    const cfg = JSON.parse(read(dir, 'iacmp.json'));
    expect(cfg.provider).toBe('aws');
    expect(cfg.accountTier).toBe('free');
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.language).toBe('typescript');
  });

  test('name derivado do basename da pasta, sanitizado', () => {
    dir = makeTmpDir();
    ensureProjectInitialized(dir, { installDeps: false });
    const cfg = JSON.parse(read(dir, 'iacmp.json'));
    // basename do tmpdir começa com "iacmp-bootstrap-" → sanitizado, sem caracteres inválidos
    expect(cfg.name).toMatch(/^[a-z0-9-_]+$/);
  });

  test('tsconfig aponta para src/ (handlers de Lambda)', () => {
    dir = makeTmpDir();
    ensureProjectInitialized(dir, { installDeps: false });
    const tsc = JSON.parse(read(dir, 'tsconfig.json'));
    expect(tsc.compilerOptions.rootDir).toBe('src');
    expect(tsc.include).toContain('src/**/*');
  });

  test('idempotente: projeto já com iacmp.json + core → no-op', () => {
    dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'iacmp.json'), '{"name":"x","provider":"aws"}');
    fs.mkdirSync(path.join(dir, 'node_modules', '@iacmp', 'core'), { recursive: true });

    const r = ensureProjectInitialized(dir, { installDeps: false });
    expect(r.bootstrapped).toBe(false);
    expect(r.created).toEqual([]);
  });

  test('respeita iacmp.json existente (não sobrescreve)', () => {
    dir = makeTmpDir();
    const original = '{"name":"meu-proj","provider":"gcp","accountTier":"standard"}';
    fs.writeFileSync(path.join(dir, 'iacmp.json'), original);

    ensureProjectInitialized(dir, { installDeps: false });

    const cfg = JSON.parse(read(dir, 'iacmp.json'));
    expect(cfg.provider).toBe('gcp');
    expect(cfg.accountTier).toBe('standard');
  });

  test('não sobrescreve package.json existente', () => {
    dir = makeTmpDir();
    const original = '{"name":"existente","version":"9.9.9"}';
    fs.writeFileSync(path.join(dir, 'package.json'), original);

    ensureProjectInitialized(dir, { installDeps: false });

    const pkg = JSON.parse(read(dir, 'package.json'));
    expect(pkg.version).toBe('9.9.9');
  });
});
