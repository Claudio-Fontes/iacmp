import { runCli, makeProject, rmrf, exists, read, ls } from './helpers';

/**
 * Black-box dos comandos de auditoria (src/commands/audit-*.ts):
 *   audit-security, audit-ha, audit-dr, audit-improvements, audit-all
 *
 * Cada comando analisa as stacks do projeto e grava um relatório em
 * audit/<nome>-<YYYY-MM-DD>.md (ver saveReport em src/audit.ts). Os testes
 * usam uma stack PROBLEMÁTICA (bucket público + sem versioning, DB single-AZ,
 * VPC single-AZ) para garantir achados, e uma stack LIMPA para o caminho feliz.
 *
 * O nome do arquivo embute a data ISO de hoje, então localizamos o relatório
 * por prefixo via ls() em vez de hardcodar a data.
 */

/** Stack com vários problemas: bucket público/sem versioning, DB single-AZ, VPC 1 AZ. */
function badStackJs(name = 'bad-stack'): string {
  return `const { Stack, Network, Storage, Database } = require('@iacmp/core');
const stack = new Stack('${name}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 1 });
new Storage.Bucket(stack, 'PublicAssets', { versioning: false, publicAccess: true });
new Database.SQL(stack, 'MainDb', { engine: 'postgres', multiAz: false });
module.exports = stack;
`;
}

/** Stack sem problemas: VPC 2 AZs, bucket versionado e privado. */
function cleanStackJs(name = 'clean-stack'): string {
  return `const { Stack, Network, Storage } = require('@iacmp/core');
const stack = new Stack('${name}');
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
module.exports = stack;
`;
}

/** Encontra o relatório <prefix>-*.md gravado em audit/. */
function reportFor(dir: string, prefix: string): string | undefined {
  return ls(dir, 'audit').find(f => f.startsWith(`${prefix}-`) && f.endsWith('.md'));
}

describe('audit-security', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('detecta bucket público e single-AZ, grava audit/security-*.md', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-security'], { cwd: dir });

    expect(r.status).toBe(0);
    // Saída no console
    expect(r.stdout).toContain('Security Audit');
    expect(r.stdout).toMatch(/Critical issues:\s*1/);
    expect(r.stdout).toContain("Storage.Bucket 'PublicAssets' — public access enabled");
    expect(r.stdout).toContain("Database.SQL 'MainDb' — no Multi-AZ");

    // Relatório em disco
    expect(exists(dir, 'audit')).toBe(true);
    const file = reportFor(dir, 'security');
    expect(file).toBeDefined();
    expect(file).toMatch(/^security-\d{4}-\d{2}-\d{2}\.md$/);

    const md = read(dir, `audit/${file}`);
    expect(md).toContain('# Security Audit Report');
    expect(md).toContain('## Summary');
    expect(md).toContain('- Critical issues: 1');
    expect(md).toContain('### [CRITICAL] ');
    expect(md).toContain('public access enabled');
    expect(md).toContain('Recommendation:');
  });

  test('stack limpa: 0 críticos e 0 warnings, relatório ainda é gravado', () => {
    dir = makeProject({ stacks: { 'clean-stack.js': cleanStackJs() } });
    const r = runCli(['audit-security'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Critical issues:\s*0/);
    expect(r.stdout).toMatch(/Warnings:\s*0/);

    const file = reportFor(dir, 'security');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('- Critical issues: 0');
    expect(md).toContain('- Warnings: 0');
    // Construtos saudáveis listados
    expect(md).toContain('## Resources with no issues');
    expect(md).not.toContain('[CRITICAL]');
  });

  test('erro claro sem iacmp.json (projeto não inicializado)', () => {
    dir = makeProject({ noConfig: true, stacks: { 'clean-stack.js': cleanStackJs() } });
    const r = runCli(['audit-security'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });

  test('erro claro sem diretório stacks/', () => {
    dir = makeProject({ noStacks: true });
    const r = runCli(['audit-security'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('stacks');
  });
});

describe('audit-ha', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('acusa VPC single-AZ e DB single-AZ como NO HA, grava audit/ha-*.md', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-ha'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('High Availability (HA) Audit');
    expect(r.stdout).toMatch(/No HA:\s*2/);
    expect(r.stdout).toContain("Network.VPC 'Vpc' — single AZ");
    expect(r.stdout).toContain("Database.SQL 'MainDb' — Single-AZ");
    // Bucket tem HA nativa
    expect(r.stdout).toContain("Storage.Bucket 'PublicAssets' — native HA");

    const file = reportFor(dir, 'ha');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('# High Availability (HA) Audit Report');
    expect(md).toContain('- No HA: 2 resources');
    expect(md).toContain('### [NO HA] ');
    expect(md).toContain('## Resources with HA');
  });

  test('stack limpa (VPC 2 AZs): nenhum NO HA', () => {
    dir = makeProject({ stacks: { 'clean-stack.js': cleanStackJs() } });
    const r = runCli(['audit-ha'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No HA:\s*0/);
    expect(r.stdout).toContain("Network.VPC 'Vpc' — 2 AZs");

    const file = reportFor(dir, 'ha');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('- No HA: 0 resources');
    expect(md).not.toContain('[NO HA]');
  });

  test('erro sem projeto inicializado', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['audit-ha'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});

describe('audit-dr', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('stack problemática: score baixo e achados NO DR, grava audit/dr-*.md', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-dr'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Disaster Recovery (DR) Audit');
    // 0/3 checks passam → score 0/10 = Critical
    expect(r.stdout).toMatch(/DR Score:\s*0\/10/);
    expect(r.stdout).toContain('Critical');
    expect(r.stdout).toContain("Storage.Bucket 'PublicAssets' — no versioning");
    expect(r.stdout).toContain("Database.SQL 'MainDb' — Single-AZ");

    const file = reportFor(dir, 'dr');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('# Disaster Recovery (DR) Audit Report');
    expect(md).toContain('## DR Score');
    expect(md).toContain('0/10 — Critical');
    // Checklist com itens não marcados
    expect(md).toContain('## DR Checklist');
    expect(md).toContain('- [ ] Buckets with versioning enabled');
    expect(md).toContain('- [ ] Multi-AZ database');
    expect(md).toContain('### [NO DR] ');
  });

  test('stack limpa: score 10/10 Excellent', () => {
    dir = makeProject({ stacks: { 'clean-stack.js': cleanStackJs() } });
    const r = runCli(['audit-dr'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DR Score:\s*10\/10/);
    expect(r.stdout).toContain('Excellent');

    const file = reportFor(dir, 'dr');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('10/10 — Excellent');
    expect(md).toContain('- [x] Buckets with versioning enabled');
    expect(md).toContain('- [x] Network with multiple AZs');
  });

  test('erro sem projeto inicializado', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['audit-dr'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});

describe('audit-improvements', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sugere versioning e Multi-AZ, grava audit/improvements-*.md', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-improvements'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Improvements Audit');
    expect(r.stdout).toMatch(/Improvements found:\s*2/);
    expect(r.stdout).toContain("Storage.Bucket 'PublicAssets' — versioning disabled");
    expect(r.stdout).toContain("Database.SQL 'MainDb' — no Multi-AZ or read replica");

    const file = reportFor(dir, 'improvements');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('# Improvements Audit Report');
    expect(md).toContain('## Improvements found: 2');
    expect(md).toContain('[DATA PROTECTION]');
    expect(md).toContain('[AVAILABILITY]');
    expect(md).toContain('Impact: High');
    expect(md).toContain('Estimated effort:');
  });

  test('stack limpa: nenhuma melhoria encontrada', () => {
    dir = makeProject({ stacks: { 'clean-stack.js': cleanStackJs() } });
    const r = runCli(['audit-improvements'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Improvements found:\s*0/);

    const file = reportFor(dir, 'improvements');
    expect(file).toBeDefined();
    const md = read(dir, `audit/${file}`);
    expect(md).toContain('## Improvements found: 0');
    expect(md).toContain('## No suggestions');
  });

  test('erro sem projeto inicializado', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['audit-improvements'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
  });
});

describe('audit-all', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('roda os 4 audits e grava os 4 relatórios em audit/', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-all'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Running all audits...');
    expect(r.stdout).toContain('Security Audit');
    expect(r.stdout).toContain('High Availability (HA) Audit');
    expect(r.stdout).toContain('Disaster Recovery (DR) Audit');
    expect(r.stdout).toContain('Improvements Audit');
    expect(r.stdout).toContain('All audits complete');

    // Os 4 relatórios devem existir
    expect(reportFor(dir, 'security')).toBeDefined();
    expect(reportFor(dir, 'ha')).toBeDefined();
    expect(reportFor(dir, 'dr')).toBeDefined();
    expect(reportFor(dir, 'improvements')).toBeDefined();

    const auditFiles = ls(dir, 'audit').filter(f => f.endsWith('.md'));
    expect(auditFiles.length).toBe(4);
  });

  test('audit-all também falha sem projeto inicializado', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['audit-all'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('init');
    // nenhum relatório deve ter sido gravado
    expect(exists(dir, 'audit')).toBe(false);
  });
});

describe('audit --fail-on (CLI-07)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('audit-security --fail-on=critical sai com 1 quando há achado crítico', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-security', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(1);
    // relatório ainda é gravado antes do exit
    expect(reportFor(dir, 'security')).toBeDefined();
  });

  test('audit-security --fail-on=critical sai com 0 quando só há warnings', () => {
    // Bucket privado sem versioning => 0 críticos, 1 warning
    const stack = `const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('warn');
new Storage.Bucket(stack, 'B', { versioning: false, publicAccess: false });
module.exports = stack;
`;
    dir = makeProject({ stacks: { 'warn-stack.js': stack } });
    const r = runCli(['audit-security', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(0);
  });

  test('audit-security --fail-on=warning sai com 1 quando há warning', () => {
    const stack = `const { Stack, Storage } = require('@iacmp/core');
const stack = new Stack('warn');
new Storage.Bucket(stack, 'B', { versioning: false, publicAccess: false });
module.exports = stack;
`;
    dir = makeProject({ stacks: { 'warn-stack.js': stack } });
    const r = runCli(['audit-security', '--fail-on=warning'], { cwd: dir });
    expect(r.status).toBe(1);
  });

  test('audit-security --fail-on=none (default) sempre sai com 0', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-security'], { cwd: dir });
    expect(r.status).toBe(0);
  });

  test('audit-all --fail-on=critical sai com 1 quando algum sub-audit é crítico', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-all', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(1);
    // os 4 relatórios ainda são gravados
    expect(reportFor(dir, 'security')).toBeDefined();
    expect(reportFor(dir, 'ha')).toBeDefined();
    expect(reportFor(dir, 'dr')).toBeDefined();
    expect(reportFor(dir, 'improvements')).toBeDefined();
  });

  test('audit-ha --fail-on=critical sai com 1 para VPC single-AZ', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-ha', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(1);
  });

  test('audit-dr --fail-on=critical sai com 1 quando há achado NO DR', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-dr', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(1);
  });

  test('audit-improvements --fail-on=critical sai com 1 para High impact', () => {
    dir = makeProject({ stacks: { 'bad-stack.js': badStackJs() } });
    const r = runCli(['audit-improvements', '--fail-on=critical'], { cwd: dir });
    expect(r.status).toBe(1);
  });
});
