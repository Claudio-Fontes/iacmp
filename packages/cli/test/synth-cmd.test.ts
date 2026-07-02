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

    test('azure → synth-out/azure/main-stack.bicep com Bicep válido', () => {
      dir = makeProject({ provider: 'azure' });
      const r = runCli(['synth', '--provider', 'azure'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join('synth-out', 'azure', 'main-stack.bicep'));
      expect(exists(dir, 'synth-out/azure/main-stack.bicep')).toBe(true);
      expect(exists(dir, 'synth-out/azure/main-stack.json')).toBe(false);
      const content = read(dir, 'synth-out/azure/main-stack.bicep');
      expect(content).toContain('resource');
    });

    test('gcp → synth-out/gcp/main-stack.tf.json com JSON Terraform válido', () => {
      dir = makeProject({ provider: 'gcp' });
      const r = runCli(['synth', '--provider', 'gcp'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join('synth-out', 'gcp', 'main-stack.tf.json'));
      expect(exists(dir, 'synth-out/gcp/main-stack.tf.json')).toBe(true);
      expect(exists(dir, 'synth-out/gcp/main-stack.json')).toBe(false);
      const parsed = JSON.parse(read(dir, 'synth-out/gcp/main-stack.tf.json'));
      expect(parsed).toHaveProperty('terraform');
      expect(parsed).toHaveProperty('resource');
    });

    test('terraform → synth-out/terraform/main-stack.tf.json com JSON válido', () => {
      dir = makeProject({ provider: 'terraform' });
      const r = runCli(['synth', '--provider', 'terraform'], { cwd: dir });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join('synth-out', 'terraform', 'main-stack.tf.json'));
      // extensão correta: .tf.json (Terraform JSON syntax)
      expect(exists(dir, 'synth-out/terraform/main-stack.tf.json')).toBe(true);
      expect(exists(dir, 'synth-out/terraform/main-stack.json')).toBe(false);

      const tfJson = read(dir, 'synth-out/terraform/main-stack.tf.json');
      // TF JSON syntax: parseável e contém chave "resource"
      const parsed = JSON.parse(tfJson);
      expect(parsed).toHaveProperty('resource');
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
      expect(exists(dir, 'synth-out/terraform/main-stack.tf.json')).toBe(true);
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

    test('handler usa pg/SQL contra projeto DynamoDB-only: bloqueia em synth', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'main-stack.js': `const { Stack, Fn, Database } = require('@iacmp/core');
const stack = new Stack('main-stack');
new Database.DynamoDB(stack, 'ProductsTable', { partitionKey: 'productId', partitionKeyType: 'S' });
new Fn.Lambda(stack, 'GetProductsFn', { runtime: 'nodejs20', handler: 'dist/getProducts.handler', code: '.' });
module.exports = stack;
`,
        },
        files: {
          'src/getProducts.ts': `import { Client } from 'pg';
const db = new Client({ host: 'dynamodb.us-east-1.amazonaws.com' });
export async function handler() {
  await db.connect();
  const r = await db.query('SELECT * FROM ProductsTable');
  return { statusCode: 200, body: JSON.stringify(r.rows) };
}
`,
        },
      });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/DynamoDB como banco SQL|driver SQL/i);
      expect(r.all).toContain('getProducts.ts');
    });

    test('Lambda em VPC acessa DynamoDB sem Gateway VpcEndpoint: bloqueia em synth', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'main-stack.js': `const { Stack, Fn, Network, Database } = require('@iacmp/core');
const stack = new Stack('main-stack');
new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });
new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
new Database.DynamoDB(stack, 'ProductsTable', { partitionKey: 'productId', partitionKeyType: 'S' });
new Fn.Lambda(stack, 'GetProductsFn', { runtime: 'nodejs20', handler: 'dist/getProducts.handler', code: '.', vpcId: 'AppVpc', subnetIds: ['PrivateSubnet1'], securityGroupIds: ['sg'] });
module.exports = stack;
`,
        },
        files: {
          'src/getProducts.ts': `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export async function handler() {
  const r = await doc.send(new GetCommand({ TableName: 'ProductsTable', Key: { productId: '1' } }));
  return { statusCode: 200, body: JSON.stringify(r.Item) };
}
`,
        },
      });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/Gateway VPC Endpoint|VpcEndpoint/i);
      expect(r.all).toContain('dynamodb');
    });

    test('Lambda em VPC acessa DynamoDB COM Gateway VpcEndpoint: passa', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'vpc.js': `const { Stack, Network } = require('@iacmp/core');
const stack = new Stack('vpc');
new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16' });
new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24' });
new Network.SecurityGroup(stack, 'LambdaSG', { vpcId: 'AppVpc', description: 'lambda' });
new Network.VpcEndpoint(stack, 'Gw', { vpcId: 'AppVpc', services: ['dynamodb'], subnetIds: ['PrivateSubnet1'] });
module.exports = stack;
`,
          'db.js': `const { Stack, Database } = require('@iacmp/core');
const stack = new Stack('db');
new Database.DynamoDB(stack, 'ProductsTable', { partitionKey: 'productId', partitionKeyType: 'S' });
module.exports = stack;
`,
          'api.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('api');
new Fn.Lambda(stack, 'GetProductsFn', { runtime: 'nodejs20', handler: 'dist/getProducts.handler', code: '.', vpcId: 'AppVpc', subnetIds: ['PrivateSubnet1'], securityGroupIds: ['LambdaSG'] });
module.exports = stack;
`,
        },
        files: {
          'src/getProducts.ts': `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export async function handler() {
  const r = await doc.send(new GetCommand({ TableName: 'ProductsTable', Key: { productId: '1' } }));
  return { statusCode: 200, body: JSON.stringify(r.Item) };
}
`,
        },
      });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).toBe(0);
    });

    test('handler com DocumentClient contra DynamoDB: passa (não é falso positivo)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'main-stack.js': `const { Stack, Fn, Database } = require('@iacmp/core');
const stack = new Stack('main-stack');
new Database.DynamoDB(stack, 'ProductsTable', { partitionKey: 'productId', partitionKeyType: 'S' });
new Fn.Lambda(stack, 'GetProductsFn', { runtime: 'nodejs20', handler: 'dist/getProducts.handler', code: '.' });
module.exports = stack;
`,
        },
        files: {
          'src/getProducts.ts': `import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export async function handler() {
  const r = await doc.send(new GetCommand({ TableName: 'ProductsTable', Key: { productId: '1' } }));
  return { statusCode: 200, body: JSON.stringify(r.Item) };
}
`,
        },
      });
      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });

      expect(r.status).toBe(0);
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
        files: { 'src/index.ts': 'export const handler = async () => ({ statusCode: 200 });\n' },
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
        files: { 'src/index.ts': 'export const handler = async () => ({ statusCode: 200 });\n' },
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

    test('Fn.Lambda com handler sem src/ correspondente → synth falha (não Cannot find module no deploy)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'WorkerFn', { runtime: 'nodejs20', handler: 'dist/worker.handler', code: '.' });
module.exports = stack;
`,
        },
        // NÃO cria src/worker.ts
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain('src/worker.ts');
    });

    test('Fn.Lambda com handler e src/ presente → synth ok', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'WorkerFn', { runtime: 'nodejs20', handler: 'dist/worker.handler', code: '.' });
module.exports = stack;
`,
        },
        files: { 'src/worker.ts': 'export const handler = async () => ({ statusCode: 200 });\n' },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).toBe(0);
    });

    test('INSERT com colunas != valores no handler → synth falha (bug createItem openai21)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'CreateFn', { runtime: 'nodejs20', handler: 'dist/create.handler', code: '.' });
module.exports = stack;
`,
        },
        files: { 'src/create.ts': `export async function handler() {
  await db.query('INSERT INTO items (name, description, created_at) VALUES ($1, $2)', [a, b]);
}
` },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain('INSERT com 3 coluna');
    });

    test('INSERT correto (colunas == valores) → synth ok', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'CreateFn', { runtime: 'nodejs20', handler: 'dist/create.handler', code: '.' });
module.exports = stack;
`,
        },
        files: { 'src/create.ts': `export async function handler() {
  await db.query('INSERT INTO items (name, description) VALUES ($1, $2)', [a, b]);
  await db.query('INSERT INTO logs (msg, created_at) VALUES ($1, NOW())', [m]);
}
` },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).toBe(0);
    });

    test('handler de Lambda-em-VPC usando Secrets Manager → synth falha (timeout openai29)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'ListFn', { runtime: 'nodejs20', handler: 'dist/list.handler', code: '.', vpcId: 'vpc-1', subnetIds: ['subnet-a','subnet-b'], securityGroupIds: ['sg-1'] });
module.exports = stack;
`,
        },
        files: { 'src/list.ts': `import { SecretsManager } from 'aws-sdk';
const s = new SecretsManager();
export async function handler() {
  const secret = await s.getSecretValue({ SecretId: process.env.DB_PASSWORD }).promise();
  return { statusCode: 200 };
}
` },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).not.toBe(0);
      expect(r.all).toContain('Secrets Manager em runtime');
    });

    test('handler de Lambda-em-VPC com senha via env → synth ok (padrão correto)', () => {
      dir = makeProject({
        provider: 'aws',
        stacks: {
          'compute.js': `const { Stack, Fn } = require('@iacmp/core');
const stack = new Stack('proj-lambda');
new Fn.Lambda(stack, 'ListFn', { runtime: 'nodejs20', handler: 'dist/list.handler', code: '.', vpcId: 'vpc-1', subnetIds: ['subnet-a','subnet-b'], securityGroupIds: ['sg-1'] });
module.exports = stack;
`,
        },
        files: { 'src/list.ts': `import { Client } from 'pg';
export async function handler() {
  const db = new Client({ host: process.env.DB_HOST, password: process.env.DB_PASSWORD });
  return { statusCode: 200 };
}
` },
      });

      const r = runCli(['synth', '--provider', 'aws'], { cwd: dir });
      expect(r.status).toBe(0);
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
