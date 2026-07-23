import type { Example } from '../index.js';

export const postgresPrivateVnet: Example = {
  id: 'azure-postgres-private-vnet',
  title: 'Azure PostgreSQL Flexible Server privado em VNet + Container App',
  tags: ['azure', 'postgresql', 'sql', 'vnet', 'private', 'container', 'flexible-server', 'pg'],
  // synth-validado; deploy real bloqueado por capacidade AKS free-tier na região
  // (Container Apps roda sobre AKS — AKSCapacityHeavyUsage), não por bug de ferramenta
  validated: false,
  stacks: {
    'stacks/network/vnet-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-vnet');
new Network.VPC(stack, 'AppVnet', { cidr: '10.42.0.0/16', maxAzs: 0 });
new Network.Subnet(stack, 'AppsSubnet', { vpcId: 'AppVnet', cidr: '10.42.0.0/23', public: false });
new Network.Subnet(stack, 'DbSubnet',   { vpcId: 'AppVnet', cidr: '10.42.2.0/28', public: false });
export default stack;`,

    'stacks/database/db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('app-db');
new Database.SQL(stack, 'AppDB', {
  engine: 'postgres',
  subnetIds: ['DbSubnet'],
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Compute, ref } from '@iacmp/core';
const stack = new Stack('app-api');
new Compute.Container(stack, 'ApiContainer', {
  build: { context: 'src/api' },
  port: 3000,
  subnetIds: ['AppsSubnet'],
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
    'src/api/index.js': `const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'postgres',
  ssl: { rejectUnauthorized: false },
});

let ready = false;
async function init() {
  if (ready) return;
  // CREATE TABLE IF NOT EXISTS na inicialização — mesmo padrão dos outros exemplos Postgres
  await pool.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
  ready = true;
}

app.get('/items', async (_req, res) => {
  await init();
  const r = await pool.query('SELECT * FROM items ORDER BY id DESC');
  res.json(r.rows);
});

app.post('/items', async (req, res) => {
  await init();
  const { name } = req.body ?? {};
  const r = await pool.query('INSERT INTO items (name) VALUES ($1) RETURNING *', [name]);
  res.status(201).json(r.rows[0]);
});

// Porta fixa 3000 — casa com Compute.Container.port; Azure Container Apps não injeta PORT
const port = 3000;
app.listen(port, () => console.log(\`listening on \${port}\`));
`,
    'src/api/package.json': `{
  "name": "app-api",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.11.5"
  }
}
`,
    'src/api/Dockerfile': `FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
`,
  },
  notes: [
    'Network.VPC + 2 Network.Subnet SEM declarar delegation — o synth Azure infere a delegation do grafo (quem usa a subnet): DbSubnet → Microsoft.DBforPostgreSQL/flexibleServers, AppsSubnet → Microsoft.App/environments',
    'Subnets EXCLUSIVAS por carga: uma subnet só aceita UMA delegation — Postgres e Container App NUNCA compartilham a mesma subnet',
    'DbSubnet cidr /28 é o MÍNIMO exigido pelo Postgres Flexible Server delegado (16 IPs) — synth rejeita prefixo > 28',
    'AppsSubnet cidr ≥/23 — Container App Environment DEDICADO (vnetConfiguration.infrastructureSubnetId) exige subnet maior que o CAE compartilhado',
    'Database.SQL com subnetIds → Postgres SEM firewall pública (0.0.0.0) — delegatedSubnetResourceId + Private DNS Zone substituem o endpoint público',
    'Compute.Container com subnetIds → Managed Environment DEDICADO (não o compartilhado da região) — obrigatório para VNet integration',
    'build: { context: "src/api" } (XOR com image) — o deploy builda a imagem local (Docker) e faz push pro ACR de bootstrap antes do `az deployment group create`',
    'DB_PASSWORD: process.env.DB_PASSWORD direto — Azure Container Apps resolve Key Vault e injeta; NUNCA chamar Key Vault SDK em runtime',
    'DB_NAME: "postgres" — Flexible Server não cria banco com nome da aplicação',
    'ssl: { rejectUnauthorized: false } obrigatório — Flexible Server exige TLS mesmo em VNet privada',
    'PORT fixo (3000) no handler — Azure Container Apps NÃO injeta env var PORT automaticamente, diferente de outras PaaS',
    'validated:false — synth comprovado (delegations, DNS zone privada, wiring cross-stack no _main.bicep); deploy real bloqueado por AKSCapacityHeavyUsage (capacidade regional de AKS, Container Apps roda sobre AKS), não por bug da ferramenta',
  ],
};
