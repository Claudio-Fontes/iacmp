import { execFileSync } from 'child_process';
import { runCli, makeProject, rmrf, CLI_BIN } from './helpers';

/**
 * Comandos "especiais" do CLI:
 *   - watch     (src/commands/watch.ts)     — fica vivo monitorando stacks/
 *   - dashboard (src/commands/dashboard.ts) — sobe um servidor HTTP e fica vivo
 *   - ai        (src/commands/ai.ts)        — gera stacks via IA (precisa de API key)
 *
 * watch e dashboard NUNCA retornam por conta própria (terminam em
 * `await new Promise(() => {})`). Testá-los com o harness runCli travaria o
 * Jest, então aqui:
 *   - o CAMINHO DE ERRO (sem iacmp.json / sem stacks/) sai rápido com exit != 0,
 *     e é exercitado via runCli normalmente;
 *   - o SMOKE de startup usa execFileSync com { timeout } próprio. Quando o
 *     processo "sobe" e fica vivo, o timeout dispara SIGTERM e o Node lança
 *     ETIMEDOUT — tratamos esse throw como "iniciou ok" e ainda inspecionamos
 *     o stdout já emitido (o banner de startup) antes do kill.
 *
 * Para `ai`, o erro de "sem API key" depende de o ambiente NÃO ter
 * ANTHROPIC_API_KEY nem GITHUB_TOKEN. O runCli herda process.env (poderia ter
 * as chaves na máquina de CI/dev), então rodamos via execFileSync passando um
 * env explícito sem essas variáveis.
 */

/** Timeout do smoke de startup (ms): tempo que deixamos watch/dashboard vivos. */
const STARTUP_TIMEOUT_MS = 3000;

interface ProcResult {
  /** true quando o timeout matou o processo => ele "subiu" e ficou vivo. */
  timedOut: boolean;
  /** exit code quando o processo terminou sozinho; null se foi morto. */
  status: number | null;
  signal: NodeJS.Signals | null;
  /** stdout + stderr concatenados, capturados até o kill/término. */
  out: string;
}

/**
 * Roda o CLI via execFileSync com timeout e env customizável.
 * Não usa runCli porque (a) precisamos do timeout para watch/dashboard e
 * (b) precisamos controlar o env (chaves de IA) por teste.
 */
function runProc(
  args: string[],
  opts: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv; stripKeys?: boolean },
): ProcResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    ...(opts.env ?? {}),
  };
  if (opts.stripKeys) {
    delete env['ANTHROPIC_API_KEY'];
    delete env['GITHUB_TOKEN'];
    // O comando `ai` carrega ~/.iacmp/config (loadEnv), que na máquina do dev tem
    // OPENAI_API_KEY. Para um teste hermético "sem key", removemos também a key
    // OpenAI/Copilot E apontamos HOME para o dir do projeto (sem .iacmp/config).
    delete env['OPENAI_API_KEY'];
    delete env['COPILOT_API_KEY'];
    delete env['IACMP_PROVIDER_AI'];
    env['HOME'] = opts.cwd;
    env['USERPROFILE'] = opts.cwd;
  }

  try {
    const out = execFileSync('node', [CLI_BIN, ...args], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout,
      env,
    });
    return { timedOut: false, status: 0, signal: null, out };
  } catch (e) {
    const err = e as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      signal?: NodeJS.Signals | null;
      code?: string;
    };
    const out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    const timedOut = err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM';
    return {
      timedOut,
      status: typeof err.status === 'number' ? err.status : null,
      signal: err.signal ?? null,
      out,
    };
  }
}

/** Porta alta/improvável para o dashboard, para não colidir com nada local. */
function freePort(): number {
  return 40000 + Math.floor(Math.random() * 20000);
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------
describe('watch — caminhos de erro (saem rápido)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem iacmp.json: erro pedindo init, exit != 0', () => {
    dir = makeProject({ noConfig: true });
    const r = runCli(['watch'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Projeto não inicializado');
    expect(r.all).toContain('iacmp init');
  });

  test('com config mas sem stacks/: erro de diretório, exit != 0', () => {
    dir = makeProject({ noStacks: true });
    const r = runCli(['watch'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('stacks/ não encontrado');
  });

  test('--help descreve o comando e os exemplos', () => {
    const r = runCli(['watch', '--help'], { cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Monitora stacks/');
    expect(r.stdout).toContain('--provider');
    expect(r.stdout).toContain('iacmp watch');
  });
});

describe('watch — smoke de startup (fica vivo => timeout)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('em projeto válido, sobe o watcher e fica vivo (banner + timeout)', () => {
    dir = makeProject({ provider: 'aws' });
    const r = runProc(['watch'], { cwd: dir, timeout: STARTUP_TIMEOUT_MS });

    // Ficou vivo até o timeout => não saiu sozinho => "iniciou ok".
    expect(r.timedOut).toBe(true);
    // E imprimiu o banner de startup antes de ser morto.
    expect(r.out).toContain('Monitorando stacks/');
  });
});

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
describe('dashboard — caminhos de erro (saem rápido)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('sem iacmp.json: erro pedindo init, exit != 0', () => {
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runCli(['dashboard'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Projeto não inicializado');
    expect(r.all).toContain('iacmp init');
  });

  test('--help descreve flags --port e --open', () => {
    const r = runCli(['dashboard', '--help'], { cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dashboard');
    expect(r.stdout).toContain('--port');
    expect(r.stdout).toContain('--open');
  });
});

describe('dashboard — smoke de startup (servidor vivo => timeout)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('em projeto válido, sobe o servidor e anuncia a URL na porta escolhida', () => {
    dir = makeProject({ provider: 'aws' });
    const port = freePort();
    const r = runProc(['dashboard', '--port', String(port)], {
      cwd: dir,
      timeout: STARTUP_TIMEOUT_MS,
    });

    // Servidor fica escutando => timeout => "iniciou ok".
    expect(r.timedOut).toBe(true);
    // Anunciou a URL com a porta que pedimos.
    expect(r.out).toContain('Dashboard disponível em');
    expect(r.out).toContain(`http://localhost:${port}`);
  });
});

// ---------------------------------------------------------------------------
// ai
// ---------------------------------------------------------------------------
describe('ai — help e validação de args', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('--help lista args/flags e sai com status 0', () => {
    const r = runCli(['ai', '--help'], { cwd: process.cwd() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Gera stacks de infraestrutura via IA');
    expect(r.stdout).toContain('--chat');
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('--provider');
  });

  test('sem prompt e sem --chat: erro pedindo o prompt, exit != 0', () => {
    dir = makeProject();
    const r = runCli(['ai'], { cwd: dir });
    expect(r.status).not.toBe(0);
    expect(r.all).toContain('Informe o prompt ou use --chat');
  });
});

describe('ai — sem API key (env limpo)', () => {
  let dir: string;
  afterEach(() => dir && rmrf(dir));

  test('ai "prompt" sem ANTHROPIC_API_KEY/GITHUB_TOKEN: erro de configuração, exit != 0', () => {
    dir = makeProject();
    // Env explícito SEM as chaves — não confiamos no process.env da máquina.
    const r = runProc(['ai', 'cria uma VPC com subnets'], {
      cwd: dir,
      stripKeys: true,
      timeout: 8000,
    });
    expect(r.status).not.toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.out).toContain('Configure ANTHROPIC_API_KEY');
  });

  test('o erro de "sem API key" acontece mesmo sem projeto inicializado', () => {
    // resolveIaCProvider cai para 'aws' sem iacmp.json; o gate da API key
    // dispara antes de qualquer chamada à IA.
    dir = makeProject({ noConfig: true, noStacks: true });
    const r = runProc(['ai', 'cria um bucket'], {
      cwd: dir,
      stripKeys: true,
      timeout: 8000,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Configure ANTHROPIC_API_KEY');
  });

  test('ai --chat sem API key: imprime banner do chat e encerra (exit != 0)', () => {
    // O modo --chat é interceptado em bin/run.js e roda dist/chat.js com stdio
    // herdado. Sem chave, ele imprime o banner e a mensagem de configuração e
    // sai — não fica preso esperando stdin. Damos um timeout de segurança.
    dir = makeProject();
    const r = runProc(['ai', '--chat'], {
      cwd: dir,
      stripKeys: true,
      timeout: 8000,
    });
    // Não deve travar: ou saiu sozinho (status != 0) ou, no pior caso, o timeout
    // o mataria — mas o esperado é término espontâneo.
    expect(r.timedOut).toBe(false);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Modo Chat Interativo');
    expect(r.out).toContain('Configure ANTHROPIC_API_KEY');
  });
});
