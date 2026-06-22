import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProjectMeta, readProjectContext } from '../src/tools/context-reader';

function makeProject(config: Record<string, unknown>, stacks: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-ctx-'));
  fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify(config));
  for (const [rel, content] of Object.entries(stacks)) {
    const full = path.join(dir, 'stacks', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ─── readProjectMeta ─────────────────────────────────────────────────────────

describe('readProjectMeta — configuração do projeto', () => {
  test('expõe provider, região, linguagem e nome', () => {
    const dir = makeProject({ name: 'meu-app', provider: 'aws', region: 'sa-east-1', language: 'typescript' });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Provider: aws');
    expect(ctx).toContain('Região: sa-east-1');
    expect(ctx).toContain('Linguagem: typescript');
    expect(ctx).toContain('Nome: meu-app');
  });

  test('usa defaults quando campos ausentes no iacmp.json', () => {
    const dir = makeProject({});
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Provider: aws');
    expect(ctx).toContain('Região: us-east-1');
  });

  test('avisa quando iacmp.json não existe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-ctx-'));
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/não inicializado|não encontrado/i);
  });

  test('avisa quando iacmp.json é JSON inválido', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-ctx-'));
    fs.writeFileSync(path.join(dir, 'iacmp.json'), 'INVALIDO');
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/inválido/i);
  });
});

describe('readProjectMeta — stacks', () => {
  test('inclui conteúdo completo de cada stack', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/lambda-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('app-lambda');
new Fn.Lambda(stack, 'ApiHandler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('### stacks/compute/lambda-stack.ts');
    expect(ctx).toContain('ApiHandler');
    expect(ctx).toContain("runtime: 'nodejs20'");
  });

  test('lê stacks de subdiretórios recursivamente', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/fn-stack.ts': 'export const a = 1;',
      'database/rds-stack.ts': 'export const b = 2;',
      'network/vpc-stack.ts': 'export const c = 3;',
      'security/secret-stack.ts': 'export const d = 4;',
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('compute/fn-stack.ts');
    expect(ctx).toContain('database/rds-stack.ts');
    expect(ctx).toContain('network/vpc-stack.ts');
    expect(ctx).toContain('security/secret-stack.ts');
  });

  test('avisa para não criar arquivo novo quando destino existe', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'network/api-gateway-stack.ts': 'export default {};',
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/não crie.*arquivo.*novo|não cri[ae].*novo.*arquivo|use exatamente estes caminhos/i);
  });

  test('avisa quando stacks/ não existe', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' });
    // sem criar pasta stacks/
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/não encontrado|nenhuma stack/i);
  });

  test('avisa quando stacks/ existe mas está vazia', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' });
    fs.mkdirSync(path.join(dir, 'stacks'));
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/nenhuma stack/i);
  });

  test('projeto azure — expõe provider azure', () => {
    const dir = makeProject({ name: 'app', provider: 'azure', region: 'eastus' }, {
      'compute/vm-stack.ts': `new Compute.Instance(stack, 'VM', { instanceType: 'medium', image: 'ubuntu-22.04' });`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Provider: azure');
    expect(ctx).toContain('Região: eastus');
    expect(ctx).toContain('VM');
  });

  test('projeto gcp — expõe provider gcp', () => {
    const dir = makeProject({ name: 'app', provider: 'gcp', region: 'us-central1' }, {
      'compute/fn-stack.ts': `new Fn.Lambda(stack, 'CloudFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Provider: gcp');
    expect(ctx).toContain('CloudFn');
  });
});

describe('readProjectMeta — stacks com estrutura correta', () => {
  test('Lambda em compute/ e ApiGateway em network/ aparecem separados', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/app-stack.ts': `new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });`,
      'network/api-gateway-stack.ts': `new Fn.ApiGateway(stack, 'HelloApi', { name: 'app-api', type: 'REST', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }] });`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('stacks/compute/app-stack.ts');
    expect(ctx).toContain('stacks/network/api-gateway-stack.ts');
    expect(ctx).toContain('HelloFn');
    expect(ctx).toContain('HelloApi');
  });

  test('múltiplas lambdas e múltiplos bancos aparecem todos no contexto', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/lambdas-stack.ts': `new Fn.Lambda(stack, 'WriterFn', {}); new Fn.Lambda(stack, 'ReaderFn', {});`,
      'database/rds-stack.ts': `new Database.SQL(stack, 'MainDB', { engine: 'postgres' });`,
      'database/dynamo-stack.ts': `new Database.DynamoDB(stack, 'EventsTable', { partitionKey: 'id' });`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('WriterFn');
    expect(ctx).toContain('ReaderFn');
    expect(ctx).toContain('MainDB');
    expect(ctx).toContain('EventsTable');
  });
});

// ─── readProjectContext (legado) ──────────────────────────────────────────────

describe('readProjectContext — comportamento legado', () => {
  test('inclui conteúdo de stacks com até 200 linhas', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/fn.ts': 'const x = 1;',
    });
    const ctx = readProjectContext(dir);
    expect(ctx).toContain('compute/fn.ts');
    expect(ctx).toContain('const x = 1;');
  });

  test('retorna contexto mesmo sem stacks', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' });
    const ctx = readProjectContext(dir);
    expect(ctx).toContain('Provider: aws');
  });
});

// ─── Integração: contexto + instrução do modelo ───────────────────────────────

describe('Integração — contexto garante que o modelo não entra em modo standalone', () => {
  test('contexto com stacks contém "Stacks existentes"', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' }, {
      'compute/fn-stack.ts': 'export default {};',
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Stacks existentes');
  });

  test('contexto sem stacks NÃO contém "Stacks existentes"', () => {
    const dir = makeProject({ name: 'app', provider: 'aws' });
    const ctx = readProjectMeta(dir);
    expect(ctx).not.toContain('Stacks existentes');
  });

  test('contexto de projeto recém criado via init contém as duas stacks padrão', () => {
    const dir = makeProject({ name: 'meu-app', provider: 'aws' }, {
      'compute/meu-app-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('meu-app-lambda');
new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10 });
export default stack;`,
      'network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('meu-app-api');
new Fn.ApiGateway(stack, 'HelloWorldApi', { name: 'meu-app-api', type: 'REST', stageName: 'prod', cors: true, authType: 'NONE', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloWorldFn' }] });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('HelloWorldFn');
    expect(ctx).toContain('HelloWorldApi');
    expect(ctx).toContain('stacks/compute/meu-app-stack.ts');
    expect(ctx).toContain('stacks/network/api-gateway-stack.ts');
  });

  test('contexto do projeto nv-vs-iac1 (caso real do bug) contém stacks corretas', () => {
    const dir = makeProject({ name: 'nv-vs-iac1', provider: 'aws', region: 'us-east-1' }, {
      'compute/nv-vs-iac1-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-lambda');
new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10 });
export default stack;`,
      'network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-api');
new Fn.ApiGateway(stack, 'HelloWorldApi', { name: 'nv-vs-iac1-api', type: 'REST', stageName: 'prod', cors: true, authType: 'NONE', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloWorldFn' }] });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    // O modelo deve ver as stacks — não deve dizer "modo standalone"
    expect(ctx).toContain('Stacks existentes');
    expect(ctx).toContain('HelloWorldFn');
    expect(ctx).toContain('HelloWorldApi');
    // Caminhos exatos devem estar presentes para o modelo usar
    expect(ctx).toContain('stacks/compute/nv-vs-iac1-stack.ts');
    expect(ctx).toContain('stacks/network/api-gateway-stack.ts');
  });
});

describe('readProjectMeta — estrutura de pastas do projeto', () => {
  test('inclui pastas e arquivos do projeto além de stacks/', () => {
    const dir = makeProject({ name: 'test', provider: 'aws' }, {
      'compute/fn.ts': 'export default {};',
    });
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');

    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('Estrutura de pastas do projeto');
    expect(ctx).toContain('src/');
    expect(ctx).toContain('index.ts');
    expect(ctx).toContain('package.json');
    expect(ctx).toContain('stacks/');
  });

  test('exclui node_modules, .git e outras pastas de build do ruído', () => {
    const dir = makeProject({ name: 'test', provider: 'aws' });
    fs.mkdirSync(path.join(dir, 'node_modules', 'alguma-lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'alguma-lib', 'index.js'), '');
    fs.mkdirSync(path.join(dir, '.git'));

    const ctx = readProjectMeta(dir);
    expect(ctx).not.toContain('node_modules');
    expect(ctx).not.toContain('.git');
  });

  test('readProjectContext (legado) também inclui a estrutura de pastas', () => {
    const dir = makeProject({ name: 'test', provider: 'aws' });
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'index.test.ts'), '');

    const ctx = readProjectContext(dir);
    expect(ctx).toContain('Estrutura de pastas do projeto');
    expect(ctx).toContain('test/');
  });
});
