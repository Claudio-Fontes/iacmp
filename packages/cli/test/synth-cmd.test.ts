import * as path from 'path';
import { runCli, makeProject, rmrf, exists, read, defaultStackJs } from './helpers';

/**
 * Testes black-box do comando `synth` (src/commands/synth.ts), rodando o binário
 * real. Complementa test/synth-out.test.ts (unit dos caminhos) e o smoke:
 *
 * - synth para os 4 providers nativos (aws/azure/gcp/terraform): caminho e
 *   extensão corretos + conteúdo válido (JSON.parse / "resource" no HCL);
 * - --stack filtrando entre 2 stacks;
 * - erros: sem stacks, provider inexistente, sem projeto.
 */

describe('synth — comando (black-box)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) {
      rmrf(dir);
      dir = '';
    }
  });

  describe('providers nativos: caminho, extensão e conteúdo válido', () => {
    test('aws → synth-out/aws/main-stack.json com JSON válido (Resources)', () => {
      dir = makeProject({ provider: 'aws' });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join('synth-out', 'aws', 'main-stack.json'));
      expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);

      // conteúdo é JSON válido e parseável
      const raw = read(dir, 'synth-out/aws/main-stack.json');
      const parsed = JSON.parse(raw);
      expect(parsed).toBeTruthy();
      // template CloudFormation tem objeto Resources com ao menos 1 recurso
      expect(parsed.Resources && typeof parsed.Resources === 'object').toBe(true);
      expect(Object.keys(parsed.Resources).length).toBeGreaterThan(0);
    });

    test('azure → synth-out/azure/main-stack.json com JSON válido', () => {
      dir = makeProject({ provider: 'azure' });
      const r = runCli(['synth', '--provider', 'azure'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/azure/main-stack.json')).toBe(true);
      const parsed = JSON.parse(read(dir, 'synth-out/azure/main-stack.json'));
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe('object');
    });

    test('gcp → synth-out/gcp/main-stack.json com JSON válido', () => {
      dir = makeProject({ provider: 'gcp' });
      const r = runCli(['synth', '--provider', 'gcp'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/gcp/main-stack.json')).toBe(true);
      const parsed = JSON.parse(read(dir, 'synth-out/gcp/main-stack.json'));
      expect(parsed).toBeTruthy();
      expect(typeof parsed).toBe('object');
    });

    test('terraform → synth-out/terraform/main-stack.tf com bloco resource', () => {
      dir = makeProject({ provider: 'terraform' });
      const r = runCli(['synth', '--provider', 'terraform'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join('synth-out', 'terraform', 'main-stack.tf'));
      // extensão correta: .tf, NÃO .json
      expect(exists(dir, 'synth-out/terraform/main-stack.tf')).toBe(true);
      expect(exists(dir, 'synth-out/terraform/main-stack.json')).toBe(false);

      const hcl = read(dir, 'synth-out/terraform/main-stack.tf');
      expect(hcl).toContain('resource');
      // HCL não deve ser JSON parseável (é texto HCL, não JSON)
      expect(() => JSON.parse(hcl)).toThrow();
    });
  });

  describe('default e flag de provider', () => {
    test('sem --provider usa aws (default da flag) e grava em synth-out/aws/', () => {
      dir = makeProject({ provider: 'aws' });
      const r = runCli(['synth'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/aws/main-stack.json')).toBe(true);
    });

    test('-p (alias curto) funciona igual a --provider', () => {
      dir = makeProject({ provider: 'aws' });
      const r = runCli(['synth', '-p', 'terraform'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/terraform/main-stack.tf')).toBe(true);
    });
  });

  describe('--stack filtra entre múltiplas stacks', () => {
    test('synthetiza só a stack pedida, ignorando a outra', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'rede.js': defaultStackJs('rede'),
          'banco.js': defaultStackJs('banco'),
        },
      });

      const r = runCli(['synth', '--provider', 'aws', '--stack', 'rede'], { cwd: dir });
      expect(r.status).toBe(0);

      expect(exists(dir, 'synth-out/aws/rede.json')).toBe(true);
      expect(exists(dir, 'synth-out/aws/banco.json')).toBe(false);
      // a saída menciona a stack sintetizada
      expect(r.stdout).toContain('rede.json');
      expect(r.stdout).not.toContain('banco.json');
    });

    test('-s (alias curto) filtra a outra stack', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'rede.js': defaultStackJs('rede'),
          'banco.js': defaultStackJs('banco'),
        },
      });

      const r = runCli(['synth', '-p', 'aws', '-s', 'banco'], { cwd: dir });
      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/aws/banco.json')).toBe(true);
      expect(exists(dir, 'synth-out/aws/rede.json')).toBe(false);
    });

    test('sem --stack sintetiza TODAS as stacks', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'rede.js': defaultStackJs('rede'),
          'banco.js': defaultStackJs('banco'),
        },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).toBe(0);
      expect(exists(dir, 'synth-out/aws/rede.json')).toBe(true);
      expect(exists(dir, 'synth-out/aws/banco.json')).toBe(true);
    });

    test('--stack com nome inexistente: erro "Nenhuma stack encontrada"', () => {
      dir = makeProject({ provider: 'aws' });
      const r = runCli(['synth', '--provider', 'aws', '--stack', 'fantasma'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/Nenhuma stack encontrada/i);
      // nada deve ser gravado para a stack inexistente
      expect(exists(dir, 'synth-out/aws/fantasma.json')).toBe(false);
    });
  });

  describe('caminhos de erro', () => {
    test('sem iacmp.json: erro pedindo para inicializar', () => {
      dir = makeProject({ noConfig: true });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all.toLowerCase()).toContain('init');
    });

    test('sem diretório stacks/: erro claro', () => {
      dir = makeProject({ noStacks: true });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/stacks\//i);
    });

    test('stacks/ vazio (sem .js/.ts): "Nenhuma stack encontrada"', () => {
      // makeProject sempre cria a stack default; usamos um arquivo não-stack
      dir = makeProject({
        provider: 'aws',
        stacks: { 'README.md': '# sem stacks aqui\n' },
      });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/Nenhuma stack encontrada/i);
    });

    test('provider inexistente: erro listando os disponíveis', () => {
      dir = makeProject({ provider: 'aws' });
      const r = runCli(['synth', '--provider', 'foobar'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/foobar/);
      expect(r.all.toLowerCase()).toContain('não encontrado');
      // sugere os providers nativos
      expect(r.all).toContain('aws');
      expect(r.all).toContain('terraform');
      // nada gravado para o provider inválido
      expect(exists(dir, 'synth-out/foobar')).toBe(false);
    });
  });

  describe('aws — referência entre stacks (Function.ApiGateway → Function.Lambda em outra stack)', () => {
    test('sintetiza as 2 stacks juntas: ImportValue na stack do gateway, Outputs/Export na stack da lambda', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
module.exports = stack;
`,
          'network.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-api');
new Fn.ApiGateway(stack, 'Api', {
  name: 'proj-api',
  type: 'REST',
  routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
});
module.exports = stack;
`,
        },
      });

      // Sem --stack: sintetiza as duas juntas — exatamente o caso real do
      // usuário (Lambda em stacks/compute/, ApiGateway em stacks/network/).
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).toBe(0);

      const networkRaw = read(dir, 'synth-out/aws/network.json');
      expect(networkRaw).toContain('Fn::ImportValue');
      expect(networkRaw).toContain('proj-lambda-HelloFn-Arn');

      const computeTpl = JSON.parse(read(dir, 'synth-out/aws/compute.json'));
      expect(computeTpl.Outputs.HelloFnArn.Export.Name).toBe('proj-lambda-HelloFn-Arn');
    });

    test('--stack filtrando só a stack do gateway AINDA resolve a referência (passada 1 carrega tudo)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
module.exports = stack;
`,
          'network.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-api');
new Fn.ApiGateway(stack, 'Api', {
  name: 'proj-api',
  routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
});
module.exports = stack;
`,
        },
      });

      const r = runCli(['synth', '--provider', 'aws', '--stack', 'network'], { cwd: dir });
      expect(r.status).toBe(0);
      // só a stack pedida foi gravada...
      expect(exists(dir, 'synth-out/aws/compute.json')).toBe(false);
      // ...mas a referência cross-stack já resolveu certo, porque a passada 1
      // carregou compute.js só pra montar o registry (sem gravar saída pra ela).
      const networkTpl = JSON.parse(read(dir, 'synth-out/aws/network.json'));
      expect(JSON.stringify(networkTpl.Resources)).toContain('proj-lambda-HelloFn-Arn');
    });

    test('lambdaId inexistente em nenhuma stack → erro claro de synth (não silencioso)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'network.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-api');
new Fn.ApiGateway(stack, 'Api', {
  name: 'proj-api',
  routes: [{ method: 'GET', path: '/hello', lambdaId: 'NaoExiste' }],
});
module.exports = stack;
`,
        },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain('NaoExiste');
    });
  });

  describe('idempotência / re-synth', () => {
    test('rodar synth duas vezes regrava o mesmo arquivo sem erro', () => {
      dir = makeProject({ provider: 'aws' });

      const first = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(first.status).toBe(0);
      const a = read(dir, 'synth-out/aws/main-stack.json');

      const second = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(second.status).toBe(0);
      const b = read(dir, 'synth-out/aws/main-stack.json');

      expect(b).toBe(a);
    });
  });
});
