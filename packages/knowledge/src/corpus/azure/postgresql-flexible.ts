import type { Example } from '../index.js';

export const postgresqlFlexible: Example = {
  id: 'azure-postgresql-flexible',
  title: 'Azure PostgreSQL Flexible Server + Container App',
  tags: ['azure', 'postgresql', 'sql', 'container', 'flexible-server', 'pg'],
  validated: true,
  stacks: {
    'stacks/database/db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('app-db');
new Database.SQL(stack, 'AppDB', { engine: 'postgres', size: 'small' });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Compute, ref } from '@iacmp/core';
const stack = new Stack('app-api');
new Compute.Container(stack, 'ApiContainer', {
  image: 'myapp:latest',
  port: 3000,
  environment: {
    DB_HOST:     ref('AppDB', 'Endpoint'),
    DB_PORT:     ref('AppDB', 'Port'),
    DB_USER:     ref('AppDB', 'Username'),
    DB_PASSWORD: ref('AppDB', 'Password'),
    DB_NAME:     'postgres',
  },
});
export default stack;`,
  },
  handlers: {
    'src/listItems.ts': `import { Client } from 'pg';
export async function handler(event: any) {
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  // CREATE TABLE IF NOT EXISTS em TODOS os handlers
  await db.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
  const r = await db.query('SELECT * FROM items');
  await db.end();
  return { statusCode: 200, body: JSON.stringify(r.rows) };
}`,
  },
  notes: [
    'DB_NAME: "postgres" — Flexible Server não cria banco com nome da aplicação, só o banco "postgres" existe por padrão',
    'DB_PASSWORD: process.env.DB_PASSWORD direto — Azure Container Apps resolve Key Vault e injeta. NUNCA chamar Key Vault SDK em runtime',
    'DB_USER: ref("AppDB","Username") — nunca hardcode "postgres"/"admin"',
    'ssl: { rejectUnauthorized: false } obrigatório — Flexible Server exige TLS',
    'CREATE TABLE IF NOT EXISTS em TODOS os handlers (list, create, get, update, delete)',
    'Policy.IAM NÃO gerar para SQL no Azure — acesso é por usuário/senha via env vars',
    'SQL parametrizado usa $1,$2 — driver pg (mesmo protocolo do RDS)',
  ],
};
