import { execFileSync } from 'child_process';
import { runCli, makeProject, rmrf, CLI_BIN } from './helpers';

/**
 * Testes do comando `doctor` (src/commands/doctor.ts).
 *
 * O doctor verifica o ambiente: versão do Node.js, versão do próprio iacmp,
 * AWS CLI e a env ANTHROPIC_API_KEY. Quando há um iacmp.json com `plugins`,
 * também lista os plugins do projeto e tenta resolvê-los a partir do cwd.
 *
 * Pontos importantes observados rodando o binário real:
 *  - O exit code é SEMPRE 0, mesmo quando alguma checagem falha (o comando
 *    nunca chama process.exit/this.error). Ver bugsFound.
 *  - A checagem ANTHROPIC_API_KEY depende do env do processo. Para asserts
 *    determinísticos sobre "configurado"/"não configurado" rodamos o binário
 *    diretamente via execFileSync controlando o env, já que o harness runCli
 *    repassa process.env sem permitir override.
 *  - AWS CLI pode ou não existir na máquina de CI; por isso não assumimos o
 *    resultado dessa checagem específica, só que a LABEL aparece.
 */

/** Roda o doctor com env totalmente controlado (sem herdar ANTHROPIC_API_KEY). */
function runDoctorWithEnv(cwd: string, extraEnv: Record<string, string | undefined>) {
  // Começa de uma cópia do env e remove explicitamente a chave para ter base limpa.
  const env: Record<string, string | undefined> = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.ANTHROPIC_API_KEY;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const stdout = execFileSync('node', [CLI_BIN, 'doctor'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv,
    });
    return { stdout, status: 0, all: stdout };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = err.stdout?.toString() ?? '';
    const stderr = err.stderr?.toString() ?? '';
    return {
      stdout,
      status: typeof err.status === 'number' ? err.status : 1,
      all: stdout + stderr,
    };
  }
}

describe('doctor — checagens de ambiente', () => {
  const dirs: string[] = [];
  const mk = (opts?: Parameters<typeof makeProject>[0]) => {
    const d = makeProject(opts);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmrf(dirs.pop()!);
  });

  test('roda sem projeto inicializado e sai com status 0', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Verificando ambiente...');
  });

  test('reporta a versão do Node.js no formato vX.Y.Z', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    // Sempre lista a label Node.js; e como o ambiente roda em Node, mostra a versão.
    expect(r.stdout).toContain('Node.js');
    expect(r.stdout).toMatch(/Node\.js v\d+\.\d+\.\d+/);
  });

  test('reporta a versão do próprio iacmp (lida do package.json)', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/iacmp v\d+\.\d+\.\d+/);
  });

  test('lista todas as checagens de ambiente', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Node.js');
    expect(r.stdout).toContain('npm');
    expect(r.stdout).toContain('iacmp');
    expect(r.stdout).toContain('AWS CLI');
    expect(r.stdout).toContain('ANTHROPIC_API_KEY');
  });

  test('lista checagens de voz (sox, whisper.cpp, modelo)', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sox');
    expect(r.stdout).toContain('whisper.cpp');
    expect(r.stdout).toContain('modelo whisper');
  });

  test('lista checagens das CLIs nativas usadas por iacmp deploy/destroy (az, gcloud, terraform)', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Azure CLI');
    expect(r.stdout).toContain('gcloud CLI');
    expect(r.stdout).toContain('Terraform CLI');
  });

  test('imprime veredicto final (OK ou itens precisam de atenção)', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Ambiente OK\. Pronto para uso\.|Alguns itens precisam de atenção\./);
  });

  test('cada linha de checagem traz um ícone ✓ ou ✗', () => {
    const dir = mk({ noConfig: true, noStacks: true });
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    // Node.js e iacmp devem passar (✓) neste ambiente de teste.
    expect(r.stdout).toMatch(/✓ Node\.js/);
    expect(r.stdout).toMatch(/✓ iacmp/);
    // Pelo menos um ícone de status aparece na saída.
    expect(r.stdout).toMatch(/[✓✗]/);
  });
});

describe('doctor — ANTHROPIC_API_KEY (env-dependente)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmrf(dirs.pop()!);
  });

  test('mostra "configurado" quando ANTHROPIC_API_KEY está no ambiente', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);
    const r = runDoctorWithEnv(dir, { ANTHROPIC_API_KEY: 'sk-ant-test-123' });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ANTHROPIC_API_KEY configurado/);
    expect(r.stdout).not.toMatch(/ANTHROPIC_API_KEY não configurado/);
  });

  test('mostra "não configurado" quando ANTHROPIC_API_KEY está ausente', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);
    const r = runDoctorWithEnv(dir, { ANTHROPIC_API_KEY: undefined });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ANTHROPIC_API_KEY não configurado');
    // É tratado como "ok" (✓), apenas informativo.
    expect(r.stdout).toMatch(/✓ ANTHROPIC_API_KEY/);
  });
});

describe('doctor — seção de plugins do projeto', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmrf(dirs.pop()!);
  });

  test('NÃO imprime "Plugins do projeto" quando não há iacmp.json', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Plugins do projeto');
  });

  test('NÃO imprime "Plugins do projeto" quando iacmp.json não tem plugins', () => {
    const dir = makeProject({
      noStacks: true,
      iacmpJson: { name: 'test', provider: 'aws', region: 'us-east-1' },
    });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Plugins do projeto');
  });

  test('NÃO imprime "Plugins do projeto" quando plugins é array vazio', () => {
    const dir = makeProject({
      noStacks: true,
      iacmpJson: { name: 'test', provider: 'aws', plugins: [] },
    });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Plugins do projeto');
  });

  test('lista cada plugin declarado em iacmp.json', () => {
    const dir = makeProject({
      noStacks: true,
      iacmpJson: {
        name: 'test',
        provider: 'aws',
        plugins: ['@iacmp/provider-aws', 'plugin-inexistente-xyz'],
      },
    });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Plugins do projeto:');
    expect(r.stdout).toContain('@iacmp/provider-aws');
    expect(r.stdout).toContain('plugin-inexistente-xyz');
  });

  test('plugin não resolvível a partir do cwd é marcado como não encontrado', () => {
    // Projeto temporário não tem node_modules, então qualquer plugin
    // (mesmo um nome de pacote real) não é resolvido => "não encontrado".
    const dir = makeProject({
      noStacks: true,
      iacmpJson: { name: 'test', provider: 'aws', plugins: ['plugin-inexistente-xyz'] },
    });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✗ plugin-inexistente-xyz não encontrado — rode npm install/);
  });

  test('iacmp.json malformado não derruba o doctor (try/catch silencioso)', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);
    // Escreve um iacmp.json inválido manualmente (makeProject sempre escreve JSON válido).
    require('fs').writeFileSync(require('path').join(dir, 'iacmp.json'), '{ not valid json');
    const r = runCli(['doctor'], { cwd: dir });

    expect(r.status).toBe(0);
    // Ainda imprime as checagens de ambiente e não a seção de plugins.
    expect(r.stdout).toContain('Verificando ambiente...');
    expect(r.stdout).not.toContain('Plugins do projeto');
  });
});

describe('doctor — exit code', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmrf(dirs.pop()!);
  });

  /**
   * CLI-DOCTOR-01: checagens OBRIGATÓRIAS (Node>=20, npm) derrubam o exit code,
   * checagens opcionais (AWS CLI, ANTHROPIC_API_KEY) ficam como info e não
   * quebram. A flag --strict promove tudo a obrigatório.
   */
  test('sai com 0 quando só faltam checagens opcionais (AWS CLI ausente)', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);
    const r = runCli(['doctor'], { cwd: dir });

    // No ambiente de teste Node>=20 e npm sempre estão presentes; AWS CLI pode
    // não estar — mas como é opcional, o exit segue 0.
    expect(r.status).toBe(0);
  });

  test('--strict sai com 1 quando alguma checagem opcional falha, e 0 quando todas passam', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);

    const r = runCli(['doctor', '--strict'], { cwd: dir });
    // noConfig:true → sem seção de plugins, então qualquer ✗ no stdout vem das checagens.
    const anyCheckFailed = /✗/.test(r.stdout);

    if (anyCheckFailed) {
      expect(r.status).toBe(1);
    } else {
      expect(r.status).toBe(0);
    }
  });
});

describe('doctor --fix — não instala nada sem confirmação do usuário', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmrf(dirs.pop()!);
  });

  test('pede confirmação para cada item corrigível e pula quando a resposta é "n"', () => {
    const dir = makeProject({ noConfig: true, noStacks: true });
    dirs.push(dir);

    // Responde "n" para qualquer prompt de confirmação — nenhum comando de
    // instalação real deve ser executado nesta suíte de testes.
    const r = runCli(['doctor', '--fix'], { cwd: dir, input: 'n\nn\nn\nn\n' });

    expect(r.status === 0 || r.status === 1).toBe(true);
    if (r.stdout.includes('executar')) {
      expect(r.stdout).toMatch(/pulado\./);
    } else {
      expect(r.stdout).toContain('Nada para corrigir automaticamente nesta plataforma.');
    }
  });
});
