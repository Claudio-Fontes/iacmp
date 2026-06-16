import * as fs from 'fs';
import * as path from 'path';

import { readConfig, loadStacks, saveReport, today } from '../src/audit';
import AuditSecurity from '../src/commands/audit-security';
import AuditHA from '../src/commands/audit-ha';
import AuditDR from '../src/commands/audit-dr';
import AuditImprovements from '../src/commands/audit-improvements';

/**
 * Teste unitário (sem subprocess) da auditoria.
 *
 * Contexto importante sobre a forma deste teste:
 * - `src/audit.ts` exporta apenas os helpers do módulo de auditoria
 *   (readConfig, loadStacks, saveReport, today). A LÓGICA DE ACHADOS
 *   (analyzeStack) vive — não exportada — dentro de cada
 *   `src/commands/audit-*.ts`. Por isso não há "função de achado" para importar
 *   isoladamente; exercitamos as regras rodando o `run()` da Command em
 *   processo (sem spawn), com `process.chdir()` para um projeto temporário e
 *   espionando `this.log` para capturar os achados.
 * - As stacks são construídas com `@iacmp/core` REAL e gravadas em .js
 *   (require('@iacmp/core')) dentro de um diretório DENTRO do pacote cli, para
 *   que a resolução de `@iacmp/core` funcione (loadStacks faz require() do
 *   arquivo da stack; de /tmp o core não resolve e a stack seria silenciosamente
 *   pulada). Cada cenário usa um subdir único para evitar o cache de require().
 *
 * Tudo roda em memória/processo: nada de execFileSync, nada de binário.
 */

// Raiz dos projetos temporários: DENTRO do pacote cli para resolver @iacmp/core.
const TMP_ROOT = path.join(__dirname, '.audit-unit-tmp');

let seq = 0;

interface TempProject {
  dir: string;
}

/**
 * Cria um projeto temporário com iacmp.json e uma stack .js cujo corpo
 * constrói os constructs desejados a partir de @iacmp/core.
 *
 * @param body trecho que recebe a variável `stack` já criada (e os namespaces
 *             Stack, Network, Storage, Database, Compute, Fn em escopo).
 */
function makeJsProject(body: string, opts: { provider?: string; name?: string } = {}): TempProject {
  const dir = path.join(TMP_ROOT, `p${seq++}`);
  fs.mkdirSync(path.join(dir, 'stacks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'iacmp.json'),
    JSON.stringify({ name: opts.name ?? 'test', provider: opts.provider ?? 'aws', region: 'us-east-1' }, null, 2),
  );
  const js = `const { Stack, Network, Storage, Database, Compute, Fn } = require('@iacmp/core');
const stack = new Stack('main-stack');
${body}
module.exports = stack;
`;
  fs.writeFileSync(path.join(dir, 'stacks', 'main-stack.js'), js);
  return { dir };
}

type AuditCommandClass =
  | typeof AuditSecurity
  | typeof AuditHA
  | typeof AuditDR
  | typeof AuditImprovements;

/**
 * Roda o `run()` de uma Command de auditoria em processo, com cwd apontando
 * para `dir`, e devolve a saída concatenada do `this.log` (a mesma coisa que o
 * usuário veria no terminal). O relatório .md também é gravado em dir/audit/ e
 * limpo junto com o projeto temporário.
 */
async function runAudit(Cmd: AuditCommandClass, dir: string): Promise<string> {
  const lines: string[] = [];
  // espiona o log da instância (prototype) sem tocar em src/.
  const spy = jest
    .spyOn(Cmd.prototype as unknown as { log: (...a: unknown[]) => void }, 'log')
    .mockImplementation((...a: unknown[]) => {
      lines.push(a.map(x => String(x)).join(' '));
    });
  const orig = process.cwd();
  try {
    process.chdir(dir);
    await (Cmd as unknown as { run: (argv: string[]) => Promise<unknown> }).run([]);
  } finally {
    process.chdir(orig);
    spy.mockRestore();
  }
  return lines.join('\n');
}

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers do módulo de auditoria (src/audit.ts) — as funções REALMENTE
// exportadas. Unidade pura, sem rodar comando.
// ---------------------------------------------------------------------------

describe('src/audit — helpers exportados', () => {
  test('readConfig lê name/provider do iacmp.json', () => {
    const { dir } = makeJsProject(`new Storage.Bucket(stack, 'B', { versioning: true, publicAccess: false });`, {
      name: 'proj-x',
      provider: 'gcp',
    });
    const cfg = readConfig(dir);
    expect(cfg.name).toBe('proj-x');
    expect(cfg.provider).toBe('gcp');
  });

  test('readConfig: sem iacmp.json lança erro pedindo init', () => {
    const dir = path.join(TMP_ROOT, `noconfig${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    expect(() => readConfig(dir)).toThrow(/iacmp init/);
  });

  test('readConfig usa defaults (basename + aws) para campos ausentes', () => {
    const dir = path.join(TMP_ROOT, 'basename-fallback');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({}));
    const cfg = readConfig(dir);
    expect(cfg.name).toBe('basename-fallback');
    expect(cfg.provider).toBe('aws');
  });

  test('loadStacks constrói Stack real de @iacmp/core a partir do .js', () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: true });`,
    );
    const stacks = loadStacks(dir);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].name).toBe('main-stack');
    expect(stacks[0].stack.constructs.map(c => c.type)).toEqual(['Storage.Bucket', 'Database.SQL']);
    // os props chegam intactos ao objeto construído.
    const bucket = stacks[0].stack.constructs[0];
    expect(bucket.props).toMatchObject({ versioning: true, publicAccess: false });
  });

  test('loadStacks: sem stacks/ lança erro', () => {
    const dir = path.join(TMP_ROOT, `nostacks${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    expect(() => loadStacks(dir)).toThrow(/stacks\//);
  });

  test('loadStacks: stacks/ vazio lança "Nenhuma stack encontrada"', () => {
    const dir = path.join(TMP_ROOT, `emptystacks${seq++}`);
    fs.mkdirSync(path.join(dir, 'stacks'), { recursive: true });
    expect(() => loadStacks(dir)).toThrow(/Nenhuma stack encontrada/);
  });

  test('saveReport grava audit/<cmd>-<data>.md e devolve caminho relativo', () => {
    const dir = path.join(TMP_ROOT, `report${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    const rel = saveReport(dir, 'security', '# hello\n');
    expect(rel).toMatch(/^audit[/\\]security-\d{4}-\d{2}-\d{2}\.md$/);
    expect(fs.readFileSync(path.join(dir, rel), 'utf-8')).toBe('# hello\n');
  });

  test('today devolve data no formato pt-BR (dd/mm/aaaa)', () => {
    expect(today()).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});

// ---------------------------------------------------------------------------
// audit-security — regras de segurança
// ---------------------------------------------------------------------------

describe('audit-security — achados de segurança', () => {
  test('Bucket publicAccess:true gera achado CRITICAL de acesso público', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'PublicAssets', { versioning: true, publicAccess: true });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain('Critical issues: 1');
    expect(out).toContain("[CRITICAL] Storage.Bucket 'PublicAssets' — public access enabled");
    // versioning está ligado: NÃO deve haver warning de versioning para este bucket.
    expect(out).not.toContain("'PublicAssets' — versioning disabled");
  });

  test('Bucket versioning desligado gera WARNING (e sem CRITICAL se privado)', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Logs', { versioning: false, publicAccess: false });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain('Critical issues: 0');
    expect(out).toContain('Warnings:        1');
    expect(out).toContain("[WARNING] Storage.Bucket 'Logs' — versioning disabled");
  });

  test('Database.SQL multiAz:false gera WARNING de Multi-AZ', async () => {
    const { dir } = makeJsProject(
      `new Database.SQL(stack, 'Db', { engine: 'mysql', multiAz: false });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain("[WARNING] Database.SQL 'Db' — no Multi-AZ");
  });

  test('Function.Lambda sem memory gera WARNING; VPC sem cidr gera WARNING', async () => {
    const { dir } = makeJsProject(
      `new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'h.handler', code: './src' });
new Network.VPC(stack, 'Vpc', { maxAzs: 2 });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain("[WARNING] Function.Lambda 'Handler' — memory not defined");
    expect(out).toContain("[WARNING] Network.VPC 'Vpc' — default CIDR");
  });

  test('Compute.Instance com publicAccess:true gera CRITICAL', async () => {
    const { dir } = makeJsProject(
      `new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ami-x', publicAccess: true });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain("[CRITICAL] Compute.Instance 'Web' — public access enabled");
  });

  test('stack 100% saudável: zero critical, zero warning, recurso marcado OK', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Safe', { versioning: true, publicAccess: false });`,
    );
    const out = await runAudit(AuditSecurity, dir);

    expect(out).toContain('Critical issues: 0');
    expect(out).toContain('Warnings:        0');
    expect(out).toContain("Storage.Bucket 'Safe' — OK");
    // grava o relatório de segurança no projeto.
    expect(fs.existsSync(path.join(dir, 'audit'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'audit')).some(f => f.startsWith('security-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit-ha — alta disponibilidade
// ---------------------------------------------------------------------------

describe('audit-ha — achados de alta disponibilidade', () => {
  test('Database.SQL multiAz:false → NO HA (Single-AZ)', async () => {
    const { dir } = makeJsProject(
      `new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: false });
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });`,
    );
    const out = await runAudit(AuditHA, dir);

    expect(out).toContain("[NO HA] Database.SQL 'Db' — Single-AZ");
    // a VPC com 2 AZs aparece como HA OK.
    expect(out).toContain("[HA OK] Network.VPC 'Vpc' — 2 AZs");
  });

  test('Database.SQL multiAz:true → HA OK (Multi-AZ enabled)', async () => {
    const { dir } = makeJsProject(
      `new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: true });
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 3 });`,
    );
    const out = await runAudit(AuditHA, dir);

    expect(out).toContain("[HA OK] Database.SQL 'Db' — Multi-AZ enabled");
    expect(out).toContain('No HA:    0');
  });

  test('VPC com maxAzs<2 → NO HA (single AZ)', async () => {
    const { dir } = makeJsProject(
      `new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 1 });`,
    );
    const out = await runAudit(AuditHA, dir);

    expect(out).toContain("[NO HA] Network.VPC 'Vpc' — single AZ");
  });

  test('stack sem VPC gera WARNING informativo "no VPC"', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });`,
    );
    const out = await runAudit(AuditHA, dir);

    expect(out).toContain("Stack 'main-stack' — no VPC");
    // bucket é considerado HA nativo.
    expect(out).toContain("[HA OK] Storage.Bucket 'Assets' — native HA");
  });

  test('uma única Compute.Instance → info de "no redundancy"', async () => {
    const { dir } = makeJsProject(
      `new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ami-x' });`,
    );
    const out = await runAudit(AuditHA, dir);

    expect(out).toContain("Compute.Instance 'Web' — no redundancy");
  });
});

// ---------------------------------------------------------------------------
// audit-dr — disaster recovery
// ---------------------------------------------------------------------------

describe('audit-dr — achados de disaster recovery', () => {
  test('bucket sem versioning + db Single-AZ + VPC single AZ → 3 NO DR e score baixo', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Logs', { versioning: false, publicAccess: false });
new Database.SQL(stack, 'Db', { engine: 'mysql', multiAz: false, instanceType: 'db.t3.medium' });
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 1 });`,
    );
    const out = await runAudit(AuditDR, dir);

    expect(out).toContain("[NO DR] Storage.Bucket 'Logs' — no versioning");
    expect(out).toContain("[NO DR] Database.SQL 'Db' — Single-AZ");
    expect(out).toContain("[NO DR] Network.VPC 'Vpc' — single AZ");
    // três checks falharam → score 0/10.
    expect(out).toMatch(/DR Score: 0\/10 — Critical/);
  });

  test('tudo configurado p/ DR → score 10/10 (Excellent), sem NO DR', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Backups', { versioning: true, publicAccess: false });
new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: true, instanceType: 'db.r6g.large' });
new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 3 });`,
    );
    const out = await runAudit(AuditDR, dir);

    expect(out).not.toContain('[NO DR]');
    expect(out).toMatch(/DR Score: 10\/10 — Excellent/);
  });

  test('Database.SQL sem instanceType gera WARNING de DR', async () => {
    const { dir } = makeJsProject(
      `new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: true });
new Storage.Bucket(stack, 'B', { versioning: true, publicAccess: false });`,
    );
    const out = await runAudit(AuditDR, dir);

    expect(out).toContain("[WARNING] Database.SQL 'Db' — instanceType not defined");
  });

  test('stack sem estado persistente → INFO "No persistent state"', async () => {
    const { dir } = makeJsProject(
      `new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });`,
    );
    const out = await runAudit(AuditDR, dir);

    expect(out).toContain('[INFO] No persistent state detected');
  });

  test('compute sem bucket → WARNING "Compute without storage"', async () => {
    const { dir } = makeJsProject(
      `new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16', maxAzs: 2 });
new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ami-x' });`,
    );
    const out = await runAudit(AuditDR, dir);

    expect(out).toContain('[WARNING] Compute without storage detected');
  });
});

// ---------------------------------------------------------------------------
// audit-improvements — sugestões de arquitetura/performance
// ---------------------------------------------------------------------------

describe('audit-improvements — sugestões', () => {
  test('Database.SQL Single-AZ → improvement AVAILABILITY de impacto High', async () => {
    const { dir } = makeJsProject(
      `new Database.SQL(stack, 'Db', { engine: 'mysql', multiAz: false });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain('[AVAILABILITY]');
    expect(out).toContain("Database.SQL 'Db' — no Multi-AZ or read replica");
    expect(out).toContain('Impact: High');
  });

  test('Bucket sem versioning → improvement DATA PROTECTION', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Logs', { versioning: false, publicAccess: false });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain('[DATA PROTECTION]');
    expect(out).toContain("Storage.Bucket 'Logs' — versioning disabled");
  });

  test('Compute.Instance small → improvement PERFORMANCE (Medium)', async () => {
    const { dir } = makeJsProject(
      `new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ami-x' });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain('[PERFORMANCE]');
    expect(out).toContain("Compute.Instance 'Web' — small instance type");
  });

  test('múltiplas instâncias sem LB → improvement ARCHITECTURE (High)', async () => {
    const { dir } = makeJsProject(
      `new Compute.Instance(stack, 'WebA', { instanceType: 'medium', image: 'ami-x' });
new Compute.Instance(stack, 'WebB', { instanceType: 'medium', image: 'ami-x' });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain('[ARCHITECTURE]');
    expect(out).toContain('Multiple instances without a load balancer');
  });

  test('VPC sem maxAzs → improvement ARCHITECTURE de maxAzs', async () => {
    const { dir } = makeJsProject(
      `new Network.VPC(stack, 'Vpc', { cidr: '10.0.0.0/16' });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain("Network.VPC 'Vpc' — maxAzs not defined");
  });

  test('stack saudável → 0 improvements e recurso marcado OK', async () => {
    const { dir } = makeJsProject(
      `new Storage.Bucket(stack, 'Safe', { versioning: true, publicAccess: false });
new Database.SQL(stack, 'Db', { engine: 'postgres', multiAz: true });`,
    );
    const out = await runAudit(AuditImprovements, dir);

    expect(out).toContain('Improvements found: 0');
    expect(out).toContain("Storage.Bucket 'Safe' — versioning enabled");
    expect(out).toContain("Database.SQL 'Db' — Multi-AZ enabled");
  });
});
