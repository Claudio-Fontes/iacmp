import { execFileSync } from 'child_process';
import { runCli, CLI_BIN } from './helpers';

/**
 * Comando `registry` (src/commands/registry.ts) + pacote @iacmp/registry.
 *
 * O `registry` NÃO depende de um projeto inicializado (não lê iacmp.json nem
 * stacks/), então roda em qualquer cwd. Usamos process.cwd() do próprio CLI.
 *
 * Nomes esperados (de packages/registry/src/registry.json):
 *   WebApp.Static  (@iacmp-community/webapp)  providers: aws
 *   Queue.SQS      (@iacmp-community/queue)    providers: aws
 *   Auth.Cognito   (@iacmp-community/auth)     providers: aws
 *
 * ATENÇÃO — diferença test-harness vs. produção (ver bug CLI-REGISTRY-01 abaixo):
 * o harness roda o CLI com NODE_ENV=test, o que coloca o oclif em "dev mode" e
 * faz ele carregar o comando a partir do PACOTE FONTE (@iacmp/registry), cujo
 * __dirname aponta para packages/registry/dist/ — onde o registry.json EXISTE.
 * Por isso o caminho feliz (list/search) FUNCIONA sob o harness. Já o usuário
 * final (NODE_ENV de produção) carrega o bundle dist/commands/registry.js, cujo
 * __dirname é dist/commands/ — onde o registry.json NÃO foi copiado pelo tsup,
 * e o comando QUEBRA com ENOENT. O último describe reproduz isso explicitamente.
 */

const CWD = process.cwd();

describe('registry list', () => {
  test('lista os 3 constructs da comunidade com pacote e providers', () => {
    const r = runCli(['registry', 'list'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Constructs disponíveis no registry');

    // nomes esperados (de registry.json)
    expect(r.stdout).toContain('WebApp.Static');
    expect(r.stdout).toContain('Queue.SQS');
    expect(r.stdout).toContain('Auth.Cognito');

    // pacotes da comunidade
    expect(r.stdout).toContain('@iacmp-community/webapp');
    expect(r.stdout).toContain('@iacmp-community/queue');
    expect(r.stdout).toContain('@iacmp-community/auth');

    // descrição e provider aparecem na tabela
    expect(r.stdout).toContain('User pool Cognito com OAuth2');
    expect(r.stdout).toContain('aws');

    // rodapé do printTable com a contagem
    expect(r.stdout).toMatch(/3 construct\(s\) encontrado\(s\)/);
  });

  test('list ignora um TERM extra (só o subcomando importa)', () => {
    // "list xpto" — o segundo arg é o slot de term, mas list não o usa
    const r = runCli(['registry', 'list', 'xpto'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WebApp.Static');
    expect(r.stdout).toMatch(/3 construct\(s\) encontrado\(s\)/);
  });
});

describe('registry search', () => {
  test('search cognito retorna apenas Auth.Cognito', () => {
    const r = runCli(['registry', 'search', 'cognito'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Buscando por "cognito"');
    expect(r.stdout).toContain('Auth.Cognito');
    expect(r.stdout).not.toContain('Queue.SQS');
    expect(r.stdout).not.toContain('WebApp.Static');
    expect(r.stdout).toMatch(/1 construct\(s\) encontrado\(s\)/);
  });

  test('search é case-insensitive e casa por descrição (SQS -> Queue.SQS)', () => {
    const r = runCli(['registry', 'search', 'sqs'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Queue.SQS');
    expect(r.stdout).not.toContain('Auth.Cognito');
    expect(r.stdout).toMatch(/1 construct\(s\) encontrado\(s\)/);
  });

  test('search casa por substring do pacote (community -> todos os 3)', () => {
    const r = runCli(['registry', 'search', 'community'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WebApp.Static');
    expect(r.stdout).toContain('Queue.SQS');
    expect(r.stdout).toContain('Auth.Cognito');
    expect(r.stdout).toMatch(/3 construct\(s\) encontrado\(s\)/);
  });

  test('termo sem correspondência mostra "Nenhum construct encontrado."', () => {
    const r = runCli(['registry', 'search', 'zzz-nao-existe-nada'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Buscando por "zzz-nao-existe-nada"');
    expect(r.stdout).toContain('Nenhum construct encontrado.');
    expect(r.stdout).not.toMatch(/construct\(s\) encontrado\(s\)/);
  });

  test('search SEM termo: erro pedindo o termo de busca', () => {
    const r = runCli(['registry', 'search'], { cwd: CWD });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Informe um termo de busca');
  });
});

describe('registry — subcomandos e uso', () => {
  test('subcomando desconhecido é rejeitado com mensagem clara', () => {
    const r = runCli(['registry', 'foo'], { cwd: CWD });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain("Subcomando desconhecido: 'foo'");
    expect(r.all).toMatch(/Use: list ou search/);
  });

  test('sem subcomando: oclif exige o arg obrigatório', () => {
    const r = runCli(['registry'], { cwd: CWD });
    expect(r.status).not.toBe(0);
    expect(r.all).toMatch(/Missing 1 required arg/i);
    expect(r.all).toContain('subcommand');
  });

  test('--help descreve o comando e os exemplos (list/search)', () => {
    const r = runCli(['registry', '--help'], { cwd: CWD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('registry de constructs da comunidade');
    expect(r.stdout).toContain('iacmp registry list');
    expect(r.stdout).toContain('iacmp registry search cognito');
    expect(r.stdout).toMatch(/SUBCOMMAND/);
  });
});

/**
 * Regressão CLI-REGISTRY-01 — registry list/search no BUNDLE de produção.
 *
 * O @iacmp/registry é INLINADO no bundle (tsup.config.ts:
 * noExternal: [/^@iacmp\/(?!core)/]) e seu client.ts lê o dado via
 * fs.readFileSync(path.join(__dirname, 'registry.json')) — no bundle __dirname é
 * <cli>/dist/commands/. O tsup empacota só JS, então o registry.json é copiado
 * para dist/commands/ via onSuccess (ver tsup.config.ts). Sem essa cópia o comando
 * estourava com ENOENT para o usuário final. Aqui forçamos NODE_ENV=production
 * (caminho do bundle) e verificamos que list/search FUNCIONAM — guarda contra a
 * regressão do data file não-empacotado.
 */
describe('registry — produção/bundle (regressão CLI-REGISTRY-01)', () => {
  function runProd(args: string[]): { status: number; out: string } {
    try {
      const out = execFileSync('node', [CLI_BIN, ...args], {
        cwd: CWD,
        encoding: 'utf-8',
        input: '',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1', NODE_ENV: 'production' },
      });
      return { status: 0, out };
    } catch (e) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      return {
        status: typeof err.status === 'number' ? err.status : 1,
        out: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''),
      };
    }
  }

  test('list resolve registry.json do bundle (sem ENOENT)', () => {
    const r = runProd(['registry', 'list']);
    expect(r.out).not.toMatch(/ENOENT/);
    expect(r.status).toBe(0);
    expect(r.out).toContain('WebApp.Static');
    expect(r.out).toMatch(/3 construct\(s\) encontrado\(s\)/);
  });

  test('search funciona no bundle de produção', () => {
    const r = runProd(['registry', 'search', 'cognito']);
    expect(r.out).not.toMatch(/ENOENT/);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Auth.Cognito');
  });

  test('"search sem termo" continua dando erro de validação (não ENOENT)', () => {
    const r = runProd(['registry', 'search']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Informe um termo de busca');
    expect(r.out).not.toMatch(/ENOENT/);
  });
});
