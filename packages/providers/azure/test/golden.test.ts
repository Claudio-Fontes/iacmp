/**
 * Golden Bicep tests — compara o output COMPLETO do emitBicep com .bicep
 * commitados. Diferente do assert de substring (que não pega output duplicado,
 * propriedade no bloco errado nem aspas duplas), o golden falha em QUALQUER
 * mudança não-intencional do synth.
 *
 * Para regenerar (após mudança intencional no synth):
 *   UPDATE_GOLDEN=1 npx jest test/golden.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Stack, Storage, Network, Database, Fn, Cache, ref } from '@iacmp/core';
import { emitBicep } from '../src';

const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function assertGolden(name: string, actual: string): void {
  if (!fs.existsSync(GOLDEN_DIR)) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const file = path.join(GOLDEN_DIR, `${name}.bicep`);
  if (UPDATE) {
    fs.writeFileSync(file, actual, 'utf-8');
    return;
  }
  const expected = fs.readFileSync(file, 'utf-8');
  expect(actual).toBe(expected);
}

describe('Golden Bicep — cenários validados em deploy real', () => {
  // ── 1. CRUD FC1 + Cosmos Table (forma do p02/TESTE12) ─────────────────────
  test('crud-fc1-cosmos', () => {
    const dbStack = new Stack('items-database-stack');
    new Database.DynamoDB(dbStack, 'ItemsTable', { partitionKey: 'id' });

    const fnStack = new Stack('crud-stack');
    new Fn.Lambda(fnStack, 'CreateItemFn', {
      runtime: 'nodejs20', handler: 'dist/createItem.handler', code: '.',
      environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
    });
    new Fn.Lambda(fnStack, 'ListItemsFn', {
      runtime: 'nodejs20', handler: 'dist/listItems.handler', code: '.',
      environment: { TABLE_NAME: ref('ItemsTable', 'Name') },
    });

    const apiStack = new Stack('api-gateway-stack');
    new Fn.ApiGateway(apiStack, 'ItemsApi', {
      name: 'items-api', type: 'HTTP', cors: true,
      routes: [
        { method: 'POST', path: '/items', lambdaId: 'CreateItemFn' },
        { method: 'GET', path: '/items', lambdaId: 'ListItemsFn' },
      ],
    });

    const all = [dbStack, fnStack, apiStack];
    assertGolden('crud-fc1-cosmos-db', emitBicep(dbStack, { accountTier: 'free', allStacks: all }));
    assertGolden('crud-fc1-cosmos-fn', emitBicep(fnStack, { accountTier: 'free', allStacks: all }));
    assertGolden('crud-fc1-cosmos-api', emitBicep(apiStack, { accountTier: 'free', allStacks: all }));
  });

  // ── 2. Postgres flexible + Function com refs (forma do p01/p09) ───────────
  test('postgres-api', () => {
    const dbStack = new Stack('rds-stack');
    new Database.SQL(dbStack, 'AppDB', { engine: 'postgres', size: 'small' } as never);

    const fnStack = new Stack('lambda-stack');
    new Fn.Lambda(fnStack, 'ListUsersFn', {
      runtime: 'nodejs20', handler: 'dist/listUsers.handler', code: '.',
      environment: {
        DB_HOST: ref('AppDB', 'Endpoint'),
        DB_PORT: ref('AppDB', 'Port'),
        DB_USER: ref('AppDB', 'Username'),
        DB_PASSWORD: ref('AppDB', 'Password'),
        DB_NAME: 'postgres',
      },
    });

    const all = [dbStack, fnStack];
    assertGolden('postgres-api-db', emitBicep(dbStack, { accountTier: 'free', allStacks: all }));
    assertGolden('postgres-api-fn', emitBicep(fnStack, { accountTier: 'free', allStacks: all }));
  });

  // ── 3. Blob + Event Grid trigger (forma do p11) ────────────────────────────
  test('blob-eventgrid', () => {
    const stack = new Stack('pipeline-stack');
    new Fn.Lambda(stack, 'ProcessorFn', {
      runtime: 'nodejs20', handler: 'dist/processor.handler', code: '.',
    });
    new Storage.Bucket(stack, 'RawDataBucket', {
      eventNotifications: [{ lambdaId: 'ProcessorFn', events: ['s3:ObjectCreated:*'] }],
    });
    assertGolden('blob-eventgrid', emitBicep(stack, { accountTier: 'free', allStacks: [stack] }));
  });

  // ── 4. Redis Standard C1 (forma do p08/p20) ────────────────────────────────
  test('redis-cache', () => {
    const cacheStack = new Stack('redis-stack');
    new Cache.Redis(cacheStack, 'ProductCache', { nodeType: 'small' });

    const fnStack = new Stack('api-stack');
    new Fn.Lambda(fnStack, 'GetProductFn', {
      runtime: 'nodejs20', handler: 'dist/getProduct.handler', code: '.',
      environment: {
        REDIS_HOST: ref('ProductCache', 'Host'),
        REDIS_PORT: ref('ProductCache', 'Port'),
        REDIS_CONNECTION_STRING: ref('ProductCache', 'ConnectionString'),
      },
    });

    const all = [cacheStack, fnStack];
    assertGolden('redis-cache-cache', emitBicep(cacheStack, { accountTier: 'free', allStacks: all }));
    assertGolden('redis-cache-fn', emitBicep(fnStack, { accountTier: 'free', allStacks: all }));
  });

  // ── 5. VNet + subnets inline + NSG (forma do p09/p10) ─────────────────────
  test('vnet-nsg', () => {
    const stack = new Stack('vpc-stack');
    new Network.VPC(stack, 'MainVnet', { cidr: '10.0.0.0/16' });
    new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'MainVnet', cidr: '10.0.1.0/24', public: false });
    new Network.Subnet(stack, 'PublicSubnet1', { vpcId: 'MainVnet', cidr: '10.0.2.0/24', public: true });
    new Network.SecurityGroup(stack, 'AppSg', {
      vpcId: 'MainVnet',
      ingressRules: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' }],
    });
    assertGolden('vnet-nsg', emitBicep(stack, { accountTier: 'free', allStacks: [stack] }));
  });
});
