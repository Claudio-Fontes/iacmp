import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli, rmrf, exists, read, ls } from './helpers';

/**
 * Testes black-box do comando `init` (src/commands/init.ts).
 *
 * `init <nome>` cria a pasta <nome> DENTRO do cwd. Por isso usamos um mkdtemp
 * próprio como cwd vazio e rodamos `init <nome>` lá dentro — o projeto fica em
 * <tmp>/<nome>. Assim conseguimos rodar `init` várias vezes em sandboxes limpas
 * e validar o conteúdo dos arquivos gerados (package.json, tsconfig, templates).
 */

/** cwd temporário e vazio onde `init <nome>` vai criar a pasta do projeto. */
function makeEmptyDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-init-'));
}

describe('init <nome> — caso feliz (template default)', () => {
  let cwd: string;
  afterEach(() => cwd && rmrf(cwd));

  test('cria iacmp.json, stacks/, package.json e tsconfig.json', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'meu-proj'], { cwd });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Projeto 'meu-proj' inicializado");

    // arquivos essenciais
    expect(exists(cwd, 'meu-proj/iacmp.json')).toBe(true);
    expect(exists(cwd, 'meu-proj/package.json')).toBe(true);
    expect(exists(cwd, 'meu-proj/tsconfig.json')).toBe(true);
    expect(exists(cwd, 'meu-proj/stacks')).toBe(true);
    expect(fs.statSync(path.join(cwd, 'meu-proj/stacks')).isDirectory()).toBe(true);
  });

  test('iacmp.json tem name/provider/region/language coerentes', () => {
    cwd = makeEmptyDir();
    runCli(['init', 'meu-proj'], { cwd });

    const cfg = JSON.parse(read(cwd, 'meu-proj/iacmp.json'));
    expect(cfg.name).toBe('meu-proj');
    expect(cfg.provider).toBe('aws'); // default
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.language).toBe('typescript'); // default
  });

  test('cria também .gitignore, .env, test/ e workflows de CI', () => {
    cwd = makeEmptyDir();
    runCli(['init', 'meu-proj'], { cwd });

    expect(exists(cwd, 'meu-proj/.gitignore')).toBe(true);
    expect(exists(cwd, 'meu-proj/.env')).toBe(true);
    expect(exists(cwd, 'meu-proj/test/meu-proj.test.ts')).toBe(true);
    expect(exists(cwd, 'meu-proj/.github/workflows/iacmp.yml')).toBe(true);
    expect(exists(cwd, 'meu-proj/.gitlab-ci.yml')).toBe(true);
  });
});

describe('init — package.json e tsconfig gerados (regressões importantes)', () => {
  let cwd: string;
  afterEach(() => cwd && rmrf(cwd));

  test('package.json referencia @iacmp/core por versão de registry (^x.y.z), NÃO file:', () => {
    cwd = makeEmptyDir();
    runCli(['init', 'pkgtest'], { cwd });

    const pkg = JSON.parse(read(cwd, 'pkgtest/package.json'));
    const coreDep = pkg.dependencies['@iacmp/core'];

    expect(coreDep).toBeDefined();
    // não pode ser um link de filesystem (regressão: file:../core quebra npm install -g)
    expect(coreDep).not.toMatch(/^file:/);
    expect(coreDep).not.toContain('..');
    expect(coreDep).not.toContain('/');
    // deve ser um range de registry semver: ^x.y.z
    expect(coreDep).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  test('package.json tem nome do projeto e scripts úteis', () => {
    cwd = makeEmptyDir();
    runCli(['init', 'pkgtest'], { cwd });

    const pkg = JSON.parse(read(cwd, 'pkgtest/package.json'));
    expect(pkg.name).toBe('pkgtest');
    expect(pkg.scripts.synth).toContain('iacmp synth');
    expect(pkg.scripts.deploy).toContain('iacmp deploy');
  });

  test('tsconfig.json NÃO tem paths absolutos (nada de /Users, /home, ../)', () => {
    cwd = makeEmptyDir();
    runCli(['init', 'tsctest'], { cwd });

    const raw = read(cwd, 'tsctest/tsconfig.json');
    const tsc = JSON.parse(raw);

    // não deve vazar caminho absoluto da máquina de quem buildou
    expect(raw).not.toContain('/Users/');
    expect(raw).not.toContain('/home/');
    expect(raw).not.toMatch(/"[^"]*\.\.\/[^"]*"/); // nenhum valor com ../

    // se houver paths/baseUrl, não podem ser absolutos
    const co = tsc.compilerOptions ?? {};
    if (co.baseUrl) {
      expect(path.isAbsolute(co.baseUrl)).toBe(false);
    }
    if (co.paths) {
      for (const arr of Object.values<string[]>(co.paths)) {
        for (const p of arr) {
          expect(path.isAbsolute(p)).toBe(false);
        }
      }
    }
    // rootDir/outDir relativos
    expect(co.rootDir).toBe('.');
    expect(path.isAbsolute(co.outDir ?? 'dist')).toBe(false);
  });
});

describe('init --list', () => {
  test('lista os templates disponíveis sem criar nada', () => {
    const cwd = makeEmptyDir();
    try {
      const r = runCli(['init', '--list'], { cwd });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Templates disponíveis');
      // cobre os principais templates documentados
      for (const t of ['default', 'rds', 'webapp', 'network', 'serverless', 'fullstack']) {
        expect(r.stdout).toContain(t);
      }
      // mostra a dica de uso
      expect(r.stdout).toContain('--template');
      // --list não deve materializar projeto nenhum no cwd
      expect(ls(cwd)).toEqual([]);
    } finally {
      rmrf(cwd);
    }
  });
});

describe('init --template', () => {
  let cwd: string;
  afterEach(() => cwd && rmrf(cwd));

  test('rds: stack na raiz de stacks/ com Network.VPC e Database.SQL', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'banco', '--template', 'rds'], { cwd });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('template: rds');

    // rds não usa stackSubDir → arquivo direto em stacks/<nome>-stack.ts
    expect(exists(cwd, 'banco/stacks/banco-stack.ts')).toBe(true);

    const stack = read(cwd, 'banco/stacks/banco-stack.ts');
    expect(stack).toContain("from '@iacmp/core'");
    expect(stack).toContain('Network.VPC');
    expect(stack).toContain('Database.SQL');
    expect(stack).toContain('postgres');

    // a saída lista os constructs do template
    expect(r.stdout).toContain('Database.SQL');
  });

  test('serverless: stack vai pra stacks/compute/ + extra stacks/network/api-gateway-stack.ts', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'srv', '--template', 'serverless'], { cwd });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('template: serverless');

    // serverless usa stackSubDir = stacks/compute
    expect(exists(cwd, 'srv/stacks/compute/srv-stack.ts')).toBe(true);
    // e adiciona um arquivo extra de API Gateway
    expect(exists(cwd, 'srv/stacks/network/api-gateway-stack.ts')).toBe(true);

    const main = read(cwd, 'srv/stacks/compute/srv-stack.ts');
    expect(main).toContain('Fn.Lambda');
    expect(main).toContain('HelloFn');
    expect(main).toContain('UsersFn');

    const api = read(cwd, 'srv/stacks/network/api-gateway-stack.ts');
    expect(api).toContain('Fn.ApiGateway');
  });

  test('provider customizado é gravado no iacmp.json', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'azproj', '--template', 'webapp', '--provider', 'azure'], { cwd });

    expect(r.status).toBe(0);
    const cfg = JSON.parse(read(cwd, 'azproj/iacmp.json'));
    expect(cfg.provider).toBe('azure');
  });
});

describe('init — casos de erro', () => {
  let cwd: string;
  afterEach(() => cwd && rmrf(cwd));

  test('erro quando a pasta já existe (não sobrescreve)', () => {
    cwd = makeEmptyDir();
    // primeira vez: ok
    const first = runCli(['init', 'dup'], { cwd });
    expect(first.status).toBe(0);

    // segunda vez na mesma pasta: erro
    const second = runCli(['init', 'dup'], { cwd });
    expect(second.status).not.toBe(0);
    expect(second.all).toContain("A pasta 'dup' já existe");
  });

  test('erro com template inexistente, listando os válidos', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'x', '--template', 'naoexiste'], { cwd });

    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('template');
    expect(r.all).toContain('naoexiste');
    // sugere os disponíveis
    expect(r.all).toContain('serverless');
    // não deve ter criado a pasta do projeto
    expect(exists(cwd, 'x')).toBe(false);
  });

  test('erro com provider inválido', () => {
    cwd = makeEmptyDir();
    const r = runCli(['init', 'x', '--provider', 'oracle'], { cwd });

    expect(r.status).not.toBe(0);
    expect(r.all.toLowerCase()).toContain('provider');
    expect(r.all).toContain('oracle');
    expect(exists(cwd, 'x')).toBe(false);
  });
});
