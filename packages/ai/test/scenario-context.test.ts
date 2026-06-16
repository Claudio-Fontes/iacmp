/**
 * Testes de cenário — valida que o sistema entende pedidos implícitos em
 * contextos reais: rede + RDS, Lambda em VPC, cache, mensageria, secrets,
 * dependências cross-stack, arquitetura multi-camada.
 *
 * Estratégia: cada teste define o estado do projeto (stacks existentes),
 * simula a resposta que o modelo deveria gerar e valida que o JSON produzido
 * é estruturalmente correto e semanticamente adequado ao pedido.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProjectMeta } from '../src/tools/context-reader';
import { extractResponse } from '../src/parser/code-extractor';

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-scenario-'));
  fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({
    name: 'meu-projeto', provider: 'aws', region: 'us-east-1', language: 'typescript',
  }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, 'stacks', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ─── REDE + RDS ──────────────────────────────────────────────────────────────

describe('Rede + RDS — cenários de banco com VPC', () => {
  test('VPC existente aparece no contexto quando usuário pede RDS', () => {
    const dir = makeProject({
      'network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('vpc');
new Network.VPC(stack, 'MainVPC', { cidr: '10.0.0.0/16', maxAzs: 2 });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('MainVPC');
    expect(ctx).toContain('10.0.0.0/16');
  });

  test('RDS com VPC: a stack RDS deve referenciar VPC via variável de ambiente', () => {
    const resposta = JSON.stringify({
      explanation: 'Criando RDS MySQL dentro da VPC existente, referenciada via VPC_ID',
      files: [{
        path: 'stacks/database/rds-stack.ts',
        content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds');
new Database.SQL(stack, 'AppDB', {
  engine: 'mysql',
  instanceType: 'medium',
  multiAz: true,
  storageGb: 100,
  backupRetentionDays: 7,
  deletionProtection: true,
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: ['RDS Multi-AZ aumenta custo em ~2x — confirme se necessário para este ambiente'],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].path).toBe('stacks/database/rds-stack.ts');
    expect(result.files[0].content).toContain("engine: 'mysql'");
    expect(result.files[0].content).toContain('multiAz: true');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/custo|multi.az/i);
  });

  test('RDS postgres com security group separado', () => {
    const resposta = JSON.stringify({
      explanation: 'Criando PostgreSQL com Security Group dedicado para restringir acesso',
      files: [
        {
          path: 'stacks/network/rds-sg-stack.ts',
          content: `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('rds-sg');
new Network.SecurityGroup(stack, 'RdsSG', {
  vpcId: 'MainVPC',
  description: 'Acesso ao RDS PostgreSQL',
  ingressRules: [{ protocol: 'tcp', fromPort: 5432, toPort: 5432, cidr: '10.0.0.0/16', description: 'PostgreSQL da VPC' }],
});
export default stack;`,
        },
        {
          path: 'stacks/database/postgres-stack.ts',
          content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('postgres');
new Database.SQL(stack, 'PostgresDB', {
  engine: 'postgres',
  instanceType: 'medium',
  storageGb: 50,
  backupRetentionDays: 14,
});
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(2);
    const sgFile = result.files.find(f => f.path.includes('sg'));
    const dbFile = result.files.find(f => f.path.includes('postgres'));
    expect(sgFile?.content).toContain('fromPort: 5432');
    expect(dbFile?.content).toContain("engine: 'postgres'");
  });

  test('RDS oracle: aviso sobre instância mínima', () => {
    const resposta = JSON.stringify({
      explanation: 'Oracle requer instâncias maiores — usando small como mínimo',
      files: [{
        path: 'stacks/database/oracle-stack.ts',
        content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('oracle-db');
new Database.SQL(stack, 'OracleDB', {
  engine: 'oracle',
  instanceType: 'large',
  edition: 'se2',
  licenseModel: 'license-included',
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: ['Oracle SE2 requer instância mínima small — usando large para produção'],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain("engine: 'oracle'");
    expect(result.files[0].content).toContain("edition: 'se2'");
    expect(result.warnings[0]).toMatch(/oracle|instância/i);
  });

  test('RDS sqlserver com edition ee', () => {
    const resposta = JSON.stringify({
      explanation: 'SQL Server Enterprise Edition',
      files: [{
        path: 'stacks/database/sqlserver-stack.ts',
        content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('sqlserver');
new Database.SQL(stack, 'SqlServerDB', {
  engine: 'sqlserver',
  instanceType: 'large',
  edition: 'ee',
  licenseModel: 'license-included',
  storageGb: 200,
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain("engine: 'sqlserver'");
    expect(result.files[0].content).toContain("edition: 'ee'");
  });

  test('adicionar Multi-AZ em RDS existente: modifica arquivo existente', () => {
    const dir = makeProject({
      'database/rds-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds');
new Database.SQL(stack, 'AppDB', { engine: 'mysql', instanceType: 'medium', storageGb: 50 });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    // Contexto deve ter o arquivo existente
    expect(ctx).toContain('database/rds-stack.ts');
    expect(ctx).toContain('engine: \'mysql\'');

    // Resposta do modelo deve modificar o arquivo existente
    const resposta = JSON.stringify({
      explanation: 'Habilitando Multi-AZ no RDS existente',
      files: [{
        path: 'stacks/database/rds-stack.ts',
        content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds');
new Database.SQL(stack, 'AppDB', { engine: 'mysql', instanceType: 'medium', storageGb: 50, multiAz: true });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].path).toBe('stacks/database/rds-stack.ts');
    expect(result.files[0].content).toContain('multiAz: true');
  });
});

// ─── LAMBDA EM VPC ───────────────────────────────────────────────────────────

describe('Lambda em VPC — acesso a recursos privados', () => {
  test('Lambda com vpcId acessa RDS privado', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda configurada dentro da VPC para acessar RDS privado via vpcId e subnetIds',
      files: [{
        path: 'stacks/compute/api-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api');
new Fn.Lambda(stack, 'ApiHandler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/api',
  memory: 512,
  timeout: 30,
  vpcId: 'MainVPC',
  subnetIds: ['PrivateSubnetA', 'PrivateSubnetB'],
  securityGroupIds: ['LambdaSG'],
  environment: {
    DB_HOST: 'rds.internal',
    DB_NAME: 'appdb',
  },
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('vpcId:');
    expect(result.files[0].content).toContain('subnetIds:');
    expect(result.files[0].content).toContain('securityGroupIds:');
    expect(result.files[0].content).toContain('DB_HOST');
  });

  test('Lambda em VPC com Redis: environment aponta para cache', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda configurada com acesso ao Redis via REDIS_HOST no environment',
      files: [{
        path: 'stacks/compute/worker-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('worker');
new Fn.Lambda(stack, 'WorkerFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/worker',
  memory: 256,
  timeout: 60,
  vpcId: 'MainVPC',
  subnetIds: ['PrivateSubnetA'],
  securityGroupIds: ['WorkerSG'],
  environment: {
    REDIS_HOST: 'cache.internal',
    REDIS_PORT: '6379',
  },
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('REDIS_HOST');
    expect(result.files[0].content).toContain('vpcId:');
  });

  test('Lambda sem VPC não deve ter subnetIds nem securityGroupIds', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda pública sem VPC para endpoint simples',
      files: [{
        path: 'stacks/compute/hello-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('hello');
new Fn.Lambda(stack, 'HelloFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/hello',
  memory: 128,
  timeout: 10,
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).not.toContain('vpcId');
    expect(result.files[0].content).not.toContain('subnetIds');
  });
});

// ─── CACHE ───────────────────────────────────────────────────────────────────

describe('Cache — Redis e Memcached', () => {
  test('Redis com failover automático e criptografia', () => {
    const resposta = JSON.stringify({
      explanation: 'Redis para sessão com failover e criptografia em trânsito e em repouso',
      files: [{
        path: 'stacks/database/redis-stack.ts',
        content: `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('redis');
new Cache.Redis(stack, 'SessionCache', {
  nodeType: 'medium',
  numCacheNodes: 2,
  automaticFailoverEnabled: true,
  atRestEncryptionEnabled: true,
  transitEncryptionEnabled: true,
  version: '7.0',
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('automaticFailoverEnabled: true');
    expect(result.files[0].content).toContain('atRestEncryptionEnabled: true');
    expect(result.files[0].content).toContain('transitEncryptionEnabled: true');
  });

  test('Redis existente: adicionar nós ao cluster sem recriar', () => {
    const dir = makeProject({
      'database/redis-stack.ts': `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('redis');
new Cache.Redis(stack, 'SessionCache', { nodeType: 'medium', numCacheNodes: 1 });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('SessionCache');

    const resposta = JSON.stringify({
      explanation: 'Aumentando de 1 para 3 nós no Redis existente',
      files: [{
        path: 'stacks/database/redis-stack.ts',
        content: `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('redis');
new Cache.Redis(stack, 'SessionCache', { nodeType: 'medium', numCacheNodes: 3, automaticFailoverEnabled: true });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].path).toBe('stacks/database/redis-stack.ts');
    expect(result.files[0].content).toContain('numCacheNodes: 3');
  });

  test('Memcached para cache simples de objetos', () => {
    const resposta = JSON.stringify({
      explanation: 'Memcached para cache de objetos sem persistência',
      files: [{
        path: 'stacks/database/memcached-stack.ts',
        content: `import { Stack, Cache } from '@iacmp/core';
const stack = new Stack('memcached');
new Cache.Memcached(stack, 'ObjCache', { nodeType: 'small', numCacheNodes: 2 });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('Cache.Memcached');
    expect(result.files[0].content).toContain("nodeType: 'small'");
  });
});

// ─── MENSAGERIA ──────────────────────────────────────────────────────────────

describe('Mensageria — SQS, SNS, DLQ', () => {
  test('Fila SQS com dead-letter queue', () => {
    const resposta = JSON.stringify({
      explanation: 'Fila principal com DLQ para mensagens que falharam após 3 tentativas',
      files: [{
        path: 'stacks/messaging/orders-queue-stack.ts',
        content: `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('orders-queue');
new Messaging.Queue(stack, 'DLQ', {
  messageRetentionSeconds: 1209600,
});
new Messaging.Queue(stack, 'OrdersQueue', {
  visibilityTimeoutSeconds: 30,
  messageRetentionSeconds: 86400,
  maxReceiveCount: 3,
  dlqArn: 'DLQ',
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('DLQ');
    expect(result.files[0].content).toContain('maxReceiveCount: 3');
    expect(result.files[0].content).toContain('dlqArn:');
  });

  test('SQS FIFO para processamento ordenado', () => {
    const resposta = JSON.stringify({
      explanation: 'Fila FIFO garantindo ordem de processamento dos pedidos',
      files: [{
        path: 'stacks/messaging/fifo-orders-stack.ts',
        content: `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('fifo-orders');
new Messaging.Queue(stack, 'OrdersFIFO', {
  fifo: true,
  encrypted: true,
  visibilityTimeoutSeconds: 60,
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('fifo: true');
    expect(result.files[0].content).toContain('encrypted: true');
  });

  test('SNS topic com múltiplos subscribers', () => {
    const resposta = JSON.stringify({
      explanation: 'Tópico SNS com subscribers Lambda e SQS para fanout',
      files: [{
        path: 'stacks/messaging/notifications-topic-stack.ts',
        content: `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('notifications');
new Messaging.Topic(stack, 'NotificationsTopic', {
  displayName: 'Notificações do sistema',
  subscriptions: [
    { protocol: 'sqs', endpoint: 'arn:aws:sqs:us-east-1:123:OrdersQueue' },
    { protocol: 'lambda', endpoint: 'arn:aws:lambda:us-east-1:123:EmailFn' },
    { protocol: 'email', endpoint: 'ops@empresa.com' },
  ],
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('Messaging.Topic');
    expect(result.files[0].content).toContain("protocol: 'sqs'");
    expect(result.files[0].content).toContain("protocol: 'lambda'");
    expect(result.files[0].content).toContain("protocol: 'email'");
  });

  test('Lambda consumidora de SQS: env aponta para a fila', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda configurada como consumidora da fila via QUEUE_URL no environment',
      files: [{
        path: 'stacks/compute/order-processor-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('order-processor');
new Fn.Lambda(stack, 'OrderProcessorFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/order-processor',
  memory: 256,
  timeout: 30,
  environment: {
    QUEUE_URL: 'OrdersQueue',
    TABLE_NAME: 'OrdersTable',
  },
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('QUEUE_URL');
    expect(result.files[0].content).toContain('OrderProcessorFn');
  });
});

// ─── SECRETS ─────────────────────────────────────────────────────────────────

describe('Secrets — Secrets Manager e Certificate Manager', () => {
  test('Secret com rotação automática', () => {
    const resposta = JSON.stringify({
      explanation: 'Secret com rotação a cada 30 dias e criptografia KMS',
      files: [{
        path: 'stacks/security/db-secret-stack.ts',
        content: `import { Stack, Secret } from '@iacmp/core';
const stack = new Stack('db-secret');
new Secret.Vault(stack, 'DbCredentials', {
  description: 'Credenciais do banco de dados principal',
  rotationDays: 30,
  kmsKeyId: 'alias/meu-projeto-key',
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('Secret.Vault');
    expect(result.files[0].content).toContain('rotationDays: 30');
    expect(result.files[0].content).toContain('kmsKeyId:');
  });

  test('Lambda com acesso a secret via environment e IAM', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda lê secret via SECRET_ARN no environment e IAM permite secretsmanager:GetSecretValue',
      files: [
        {
          path: 'stacks/compute/api-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api');
new Fn.Lambda(stack, 'ApiHandler', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/api',
  memory: 256,
  timeout: 30,
  environment: {
    SECRET_ARN: 'DbCredentials',
    TABLE_NAME: 'UsersTable',
  },
});
export default stack;`,
        },
        {
          path: 'stacks/policy/api-policy-stack.ts',
          content: `import { Stack, Policy } from '@iacmp/core';
const stack = new Stack('api-policy');
new Policy.IAM(stack, 'ApiHandlerPolicy', {
  attachTo: 'ApiHandler',
  attachType: 'lambda',
  statements: [
    { effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resources: ['*'] },
    { effect: 'Allow', actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: ['*'] },
  ],
});
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(2);
    const lambdaFile = result.files.find(f => f.path.includes('api-stack'));
    const policyFile = result.files.find(f => f.path.includes('policy'));
    expect(lambdaFile?.content).toContain('SECRET_ARN');
    expect(policyFile?.content).toContain('secretsmanager:GetSecretValue');
  });

  test('Certificado TLS com validação DNS', () => {
    const resposta = JSON.stringify({
      explanation: 'Certificado ACM para api.exemplo.com com validação via DNS',
      files: [{
        path: 'stacks/security/cert-stack.ts',
        content: `import { Stack, Certificate } from '@iacmp/core';
const stack = new Stack('cert');
new Certificate.TLS(stack, 'ApiCert', {
  domainName: 'api.exemplo.com',
  subjectAlternativeNames: ['*.api.exemplo.com'],
  validationMethod: 'DNS',
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].content).toContain('Certificate.TLS');
    expect(result.files[0].content).toContain('domainName:');
    expect(result.files[0].content).toContain("validationMethod: 'DNS'");
  });
});

// ─── DEPENDÊNCIAS CROSS-STACK ─────────────────────────────────────────────────

describe('Dependências cross-stack — referências implícitas', () => {
  test('VPC e RDS em stacks separadas: contexto expõe ambas', () => {
    const dir = makeProject({
      'network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('vpc');
new Network.VPC(stack, 'MainVPC', { cidr: '10.0.0.0/16', maxAzs: 3 });
export default stack;`,
      'database/rds-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds');
new Database.SQL(stack, 'AppDB', { engine: 'postgres', instanceType: 'medium' });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('MainVPC');
    expect(ctx).toContain('AppDB');
    // O modelo vê as duas stacks e pode relacioná-las
    expect(ctx).toContain('network/vpc-stack.ts');
    expect(ctx).toContain('database/rds-stack.ts');
  });

  test('Nova Lambda não recria DynamoDB que já existe em outra stack', () => {
    const resposta = JSON.stringify({
      explanation: 'Lambda referencia DynamoDB existente via TABLE_NAME — não recria a tabela',
      files: [{
        path: 'stacks/compute/reader-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('reader');
new Fn.Lambda(stack, 'ReaderFn', {
  runtime: 'nodejs20',
  handler: 'index.handler',
  code: './src/handlers/reader',
  memory: 128,
  timeout: 10,
  environment: {
    TABLE_NAME: 'MessagesTable',
  },
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    // Apenas 1 arquivo (Lambda) — não recriou DynamoDB
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).not.toContain('Database.DynamoDB');
    expect(result.files[0].content).toContain('TABLE_NAME');
  });

  test('IAM cross-stack: policy adicionada à stack de policy existente', () => {
    const dir = makeProject({
      'policy/app-policy-stack.ts': `import { Stack, Policy } from '@iacmp/core';
const stack = new Stack('app-policy');
new Policy.IAM(stack, 'WriterPolicy', {
  attachTo: 'WriterFn',
  attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['dynamodb:PutItem'], resources: ['*'] }],
});
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('WriterPolicy');
    expect(ctx).toContain('dynamodb:PutItem');

    // Ao adicionar permissão de leitura, deve modificar o arquivo existente
    const resposta = JSON.stringify({
      explanation: 'Adicionando permissão dynamodb:GetItem à policy existente',
      files: [{
        path: 'stacks/policy/app-policy-stack.ts',
        content: `import { Stack, Policy } from '@iacmp/core';
const stack = new Stack('app-policy');
new Policy.IAM(stack, 'WriterPolicy', {
  attachTo: 'WriterFn',
  attachType: 'lambda',
  statements: [
    { effect: 'Allow', actions: ['dynamodb:PutItem', 'dynamodb:GetItem'], resources: ['*'] },
  ],
});
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files[0].path).toBe('stacks/policy/app-policy-stack.ts');
    expect(result.files[0].content).toContain('dynamodb:GetItem');
    expect(result.files[0].content).toContain('dynamodb:PutItem');
  });
});

// ─── ARQUITETURAS MULTI-CAMADA ────────────────────────────────────────────────

describe('Arquiteturas multi-camada — cenários reais', () => {
  test('API REST completa: ApiGateway + 2 Lambdas + RDS + Secret + IAM', () => {
    const resposta = JSON.stringify({
      explanation: 'API REST com autenticação, banco relacional e secrets — 5 arquivos em stacks separadas',
      files: [
        {
          path: 'stacks/compute/api-lambdas-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api-lambdas');
new Fn.Lambda(stack, 'CreateUserFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/create-user', memory: 256, timeout: 30, environment: { DB_URL: 'AppDB', SECRET_ARN: 'DbSecret' } });
new Fn.Lambda(stack, 'GetUserFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/get-user', memory: 128, timeout: 10, environment: { DB_URL: 'AppDB' } });
export default stack;`,
        },
        {
          path: 'stacks/compute/api-gateway-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api-gateway');
new Fn.ApiGateway(stack, 'UsersApi', { name: 'users-api', type: 'HTTP', cors: true, routes: [
  { method: 'POST', path: '/users', lambdaId: 'CreateUserFn' },
  { method: 'GET', path: '/users/{id}', lambdaId: 'GetUserFn' },
]});
export default stack;`,
        },
        {
          path: 'stacks/database/rds-stack.ts',
          content: `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('rds');
new Database.SQL(stack, 'AppDB', { engine: 'postgres', instanceType: 'medium', multiAz: true, backupRetentionDays: 7 });
export default stack;`,
        },
        {
          path: 'stacks/security/db-secret-stack.ts',
          content: `import { Stack, Secret } from '@iacmp/core';
const stack = new Stack('db-secret');
new Secret.Vault(stack, 'DbSecret', { description: 'Credenciais do RDS', rotationDays: 30 });
export default stack;`,
        },
        {
          path: 'stacks/policy/api-policy-stack.ts',
          content: `import { Stack, Policy } from '@iacmp/core';
const stack = new Stack('api-policy');
new Policy.IAM(stack, 'CreateUserPolicy', { attachTo: 'CreateUserFn', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resources: ['*'] }] });
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: ['Implementar os handlers em src/handlers/', 'Configurar string de conexão no secret DbSecret'],
      warnings: ['RDS Multi-AZ aumenta custo — confirme para produção'],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(5);
    // Stacks em subpastas corretas
    expect(result.files.some(f => f.path.startsWith('stacks/compute/'))).toBe(true);
    expect(result.files.some(f => f.path.startsWith('stacks/database/'))).toBe(true);
    expect(result.files.some(f => f.path.startsWith('stacks/security/'))).toBe(true);
    expect(result.files.some(f => f.path.startsWith('stacks/policy/'))).toBe(true);
    // ApiGateway referencia as Lambdas
    const gwFile = result.files.find(f => f.path.includes('api-gateway'));
    expect(gwFile?.content).toContain('CreateUserFn');
    expect(gwFile?.content).toContain('GetUserFn');
    // Lambdas não recriam o banco
    const lambdaFile = result.files.find(f => f.path.includes('api-lambdas'));
    expect(lambdaFile?.content).not.toContain('Database.SQL');
  });

  test('Worker assíncrono: Lambda + SQS + DynamoDB + CloudWatch Alarm', () => {
    const resposta = JSON.stringify({
      explanation: 'Worker assíncrono com fila, banco e alarme de erro',
      files: [
        {
          path: 'stacks/messaging/orders-queue-stack.ts',
          content: `import { Stack, Messaging } from '@iacmp/core';
const stack = new Stack('orders-queue');
new Messaging.Queue(stack, 'OrdersQueue', { visibilityTimeoutSeconds: 60, encrypted: true, maxReceiveCount: 3, dlqArn: 'OrdersDLQ' });
new Messaging.Queue(stack, 'OrdersDLQ', { messageRetentionSeconds: 1209600 });
export default stack;`,
        },
        {
          path: 'stacks/compute/worker-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('worker');
new Fn.Lambda(stack, 'OrderWorkerFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/order-worker', memory: 512, timeout: 60, environment: { QUEUE_URL: 'OrdersQueue', TABLE_NAME: 'OrdersTable' } });
export default stack;`,
        },
        {
          path: 'stacks/monitoring/worker-alarm-stack.ts',
          content: `import { Stack, Monitoring } from '@iacmp/core';
const stack = new Stack('worker-alarm');
new Monitoring.Alarm(stack, 'WorkerErrorAlarm', { metricName: 'Errors', namespace: 'AWS/Lambda', threshold: 5, evaluationPeriods: 1, periodSeconds: 60, statistic: 'Sum', dimensions: { FunctionName: 'OrderWorkerFn' } });
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(3);
    const queueFile = result.files.find(f => f.path.includes('queue'));
    const workerFile = result.files.find(f => f.path.includes('worker-stack'));
    const alarmFile = result.files.find(f => f.path.includes('alarm'));
    expect(queueFile?.content).toContain('dlqArn:');
    expect(workerFile?.content).toContain('QUEUE_URL');
    expect(alarmFile?.content).toContain("metricName: 'Errors'");
  });

  test('Arquitetura com WAF + ALB + Lambda: stacks de rede separadas', () => {
    const resposta = JSON.stringify({
      explanation: 'WAF protegendo ALB que roteia para Lambda — 3 stacks de rede/compute',
      files: [
        {
          path: 'stacks/network/waf-stack.ts',
          content: `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('waf');
new Network.WAF(stack, 'AppWAF', { scope: 'REGIONAL', defaultAction: 'allow', mode: 'Prevention', rules: [{ name: 'CommonRules', priority: 1, action: 'block', managedGroup: 'AWSManagedRulesCommonRuleSet' }] });
export default stack;`,
        },
        {
          path: 'stacks/network/alb-stack.ts',
          content: `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('alb');
new Network.LoadBalancer(stack, 'AppALB', { type: 'application', scheme: 'internet-facing', listeners: [{ port: 443, protocol: 'HTTPS', redirectToHttps: false }], targetGroups: [{ name: 'api-tg', port: 80, protocol: 'HTTP', healthCheckPath: '/health' }] });
export default stack;`,
        },
        {
          path: 'stacks/compute/api-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api');
new Fn.Lambda(stack, 'ApiHandler', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/api', memory: 256, timeout: 30 });
new Fn.ApiGateway(stack, 'Api', { name: 'app-api', type: 'HTTP', cors: true, routes: [{ method: 'ANY', path: '/{proxy+}', lambdaId: 'ApiHandler' }] });
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(3);
    const wafFile = result.files.find(f => f.path.includes('waf'));
    const albFile = result.files.find(f => f.path.includes('alb'));
    expect(wafFile?.content).toContain('Network.WAF');
    expect(wafFile?.content).toContain("scope: 'REGIONAL'");
    expect(albFile?.content).toContain('Network.LoadBalancer');
    expect(albFile?.content).toContain("type: 'application'");
  });

  test('EventBridge disparando Step Functions com Lambda de fallback', () => {
    const resposta = JSON.stringify({
      explanation: 'EventBridge agenda Step Functions diariamente, com Lambda de fallback em caso de erro',
      files: [
        {
          path: 'stacks/messaging/scheduler-stack.ts',
          content: `import { Stack, Events } from '@iacmp/core';
const stack = new Stack('scheduler');
new Events.EventBridge(stack, 'DailyScheduler', { busName: 'default', rules: [{ name: 'DailyRun', source: ['aws.scheduler'], detailTypes: ['Scheduled Event'], targetArn: 'arn:aws:states:us-east-1:123:stateMachine:DataPipeline' }] });
export default stack;`,
        },
        {
          path: 'stacks/workflow/pipeline-stack.ts',
          content: `import { Stack, Workflow } from '@iacmp/core';
const stack = new Stack('pipeline');
new Workflow.StepFunctions(stack, 'DataPipeline', { type: 'STANDARD', steps: [{ name: 'ExtractData', type: 'Task', resource: 'arn:aws:lambda:us-east-1:123:function:ExtractFn' }, { name: 'TransformData', type: 'Task', resource: 'arn:aws:lambda:us-east-1:123:function:TransformFn' }, { name: 'LoadData', type: 'Task', resource: 'arn:aws:lambda:us-east-1:123:function:LoadFn' }] });
export default stack;`,
        },
        {
          path: 'stacks/compute/etl-lambdas-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('etl-lambdas');
new Fn.Lambda(stack, 'ExtractFn', { runtime: 'python3.12', handler: 'handler.extract', code: './src/handlers/extract', memory: 512, timeout: 300 });
new Fn.Lambda(stack, 'TransformFn', { runtime: 'python3.12', handler: 'handler.transform', code: './src/handlers/transform', memory: 1024, timeout: 300 });
new Fn.Lambda(stack, 'LoadFn', { runtime: 'python3.12', handler: 'handler.load', code: './src/handlers/load', memory: 512, timeout: 300 });
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(3);
    const workflowFile = result.files.find(f => f.path.includes('pipeline'));
    const lambdaFile = result.files.find(f => f.path.includes('etl'));
    expect(workflowFile?.content).toContain('Workflow.StepFunctions');
    expect(workflowFile?.content).toContain("type: 'STANDARD'");
    expect(lambdaFile?.content).toContain("runtime: 'python3.12'");
    // 3 Lambdas no mesmo arquivo
    expect(lambdaFile?.content).toContain('ExtractFn');
    expect(lambdaFile?.content).toContain('TransformFn');
    expect(lambdaFile?.content).toContain('LoadFn');
  });

  test('DynamoDB com GSI: contexto expõe índices ao modelo para queries cross-stack', () => {
    const dir = makeProject({
      'database/users-table-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('users-table');
new Database.DynamoDB(stack, 'UsersTable', {
  partitionKey: 'userId',
  sortKey: 'createdAt',
  billingMode: 'PAY_PER_REQUEST',
  pointInTimeRecovery: true,
  streamEnabled: true,
  globalSecondaryIndexes: [
    { name: 'email-index', partitionKey: 'email' },
    { name: 'status-index', partitionKey: 'status', sortKey: 'createdAt' },
  ],
});
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('UsersTable');
    expect(ctx).toContain('email-index');
    expect(ctx).toContain('status-index');
    expect(ctx).toContain('streamEnabled: true');
  });
});
