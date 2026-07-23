import type { Example } from '../index.js';

export const rdsLambdaVpc: Example = {
  id: 'aws-rds-lambda-vpc',
  title: 'Lambda + PostgreSQL RDS em VPC',
  tags: ['aws', 'rds', 'postgresql', 'lambda', 'vpc', 'pool', 'sql'],
  validated: true,
  stacks: {
    'stacks/network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-vpc');
new Network.VPC(stack, 'AppVpc', { cidr: '10.0.0.0/16', maxAzs: 0 });
new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.0.1.0/24', public: false });
new Network.Subnet(stack, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.0.2.0/24', public: false });
new Network.SecurityGroup(stack, 'LambdaSG', { vpcId: 'AppVpc', description: 'Lambda' });
new Network.SecurityGroup(stack, 'DBSG',     { vpcId: 'AppVpc', description: 'RDS' });
export default stack;`,

    'stacks/database/db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('app-db');
new Database.SQL(stack, 'AppDB', {
  engine: 'postgres',
  instanceType: 'db.t3.micro',
  backupRetentionDays: 0,
  storageEncrypted: false,
  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
  securityGroupIds: ['DBSG'],
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('app-api');
const vpc = { vpcId: 'AppVpc', subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'], securityGroupIds: ['LambdaSG'] };
const db = { DB_HOST: ref('AppDB', 'Endpoint'), DB_PORT: ref('AppDB', 'Port'), DB_USER: ref('AppDB', 'Username'), DB_PASSWORD: ref('AppDB', 'Password'), DB_NAME: 'postgres' };
new Fn.Lambda(stack, 'ListItemsFn',  { runtime: 'nodejs20', handler: 'dist/listItems.handler',  code: '.', environment: db, ...vpc });
new Fn.Lambda(stack, 'CreateItemFn', { runtime: 'nodejs20', handler: 'dist/createItem.handler', code: '.', environment: db, ...vpc });
export default stack;`,
  },
  handlers: {
    'src/listItems.ts': `import { Pool } from 'pg';
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });
let ready = false;
async function init() {
  if (ready) return;
  await pool.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())');
  ready = true;
}
export async function handler() {
  await init();
  const r = await pool.query('SELECT * FROM items ORDER BY created_at DESC');
  return { statusCode: 200, body: JSON.stringify(r.rows) };
}`,
    'src/createItem.ts': `import { Pool } from 'pg';
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });
let ready = false;
async function init() {
  if (ready) return;
  await pool.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())');
  ready = true;
}
export async function handler(event: any) {
  await init();
  const { name } = JSON.parse(event.body ?? '{}');
  const r = await pool.query('INSERT INTO items (name) VALUES ($1) RETURNING *', [name]);
  return { statusCode: 201, body: JSON.stringify(r.rows[0]) };
}`,
  },
  notes: [
    'maxAzs: 0 quando há Network.Subnet explícitas — mutuamente exclusivos',
    'DB_USER: ref("AppDB","Username") — NUNCA hardcode "postgres"/"root"/"admin"',
    'DB_PASSWORD: process.env.DB_PASSWORD direto — synth injeta {{resolve:secretsmanager}}, NUNCA chamar Secrets Manager SDK no handler',
    'ssl: { rejectUnauthorized: false } obrigatório — RDS exige TLS',
    'Pool (não Client) para reutilizar conexões entre invocações',
    'CREATE TABLE IF NOT EXISTS em TODOS os handlers (não só listagem)',
    'SQL parametrizado usa $1,$2 (não ?) — driver pg',
    'Secret.Vault NÃO criar — Database.SQL já cria automaticamente',
    'RDS dentro da VPC não precisa de VpcEndpoint — Lambda alcança pela subnet privada + SG',
  ],
};
