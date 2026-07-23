import type { Example } from '../index.js';

export const documentdbLambdaVpc: Example = {
  id: 'aws-documentdb-lambda-vpc',
  title: 'Lambda + DocumentDB (MongoDB compatível) em VPC',
  tags: ['aws', 'documentdb', 'mongodb', 'lambda', 'vpc', 'sql'],
  // synth-validado (cluster+instância+secret+exports corretos); deploy real NÃO
  // executado por decisão do usuário — DocumentDB é pago (db.t3.medium ~$0.08/h),
  // sem tier grátis
  validated: false,
  stacks: {
    'stacks/network/vpc-stack.ts': `import { Stack, Network } from '@iacmp/core';
const stack = new Stack('app-vpc');
new Network.VPC(stack, 'AppVpc', { cidr: '10.70.0.0/16', maxAzs: 0 });
new Network.Subnet(stack, 'PrivateSubnet1', { vpcId: 'AppVpc', cidr: '10.70.1.0/24', availabilityZone: 'us-east-1a', public: false });
new Network.Subnet(stack, 'PrivateSubnet2', { vpcId: 'AppVpc', cidr: '10.70.2.0/24', availabilityZone: 'us-east-1b', public: false });
new Network.SecurityGroup(stack, 'LambdaSG', { vpcId: 'AppVpc', description: 'Lambda' });
new Network.SecurityGroup(stack, 'DocDbSG',  { vpcId: 'AppVpc', description: 'DocumentDB', ingressRules: [{ protocol: 'tcp', fromPort: 27017, toPort: 27017, sourceSecurityGroupId: 'LambdaSG' }] });
export default stack;`,

    'stacks/database/db-stack.ts': `import { Stack, Database } from '@iacmp/core';
const stack = new Stack('app-db');
new Database.DocumentDB(stack, 'AppDocDb', {
  instances: 1,
  instanceType: 'db.t3.medium',
  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
  securityGroupIds: ['DocDbSG'],
});
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, ref } from '@iacmp/core';
const stack = new Stack('app-api');
new Fn.Lambda(stack, 'ListItemsFn', {
  runtime: 'nodejs20',
  handler: 'dist/listItems.handler',
  code: '.',
  environment: {
    DB_HOST:     ref('AppDocDb', 'Endpoint'),
    DB_PORT:     ref('AppDocDb', 'Port'),
    DB_PASSWORD: ref('AppDocDb', 'Password'),
  },
  vpcId: 'AppVpc',
  subnetIds: ['PrivateSubnet1', 'PrivateSubnet2'],
  securityGroupIds: ['LambdaSG'],
});
export default stack;`,
  },
  handlers: {
    'src/listItems.ts': `import { MongoClient } from 'mongodb';
// DocumentDB fixa o master username como 'docdbadmin' — não é ref(), é constante da plataforma.
const MASTER_USERNAME = 'docdbadmin';
let client: MongoClient | null = null;
async function getClient(): Promise<MongoClient> {
  if (client) return client;
  const password = encodeURIComponent(process.env.DB_PASSWORD as string);
  const uri = \`mongodb://\${MASTER_USERNAME}:\${password}@\${process.env.DB_HOST}:\${process.env.DB_PORT}/?tls=true&replicaSet=rs0&readPreference=secondaryPreferred\`;
  client = new MongoClient(uri, {
    tlsCAFile: 'global-bundle.pem', // empacotado junto do código — baixado de https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    retryWrites: false, // DocumentDB NÃO suporta retryable writes (diferente do MongoDB Atlas)
  });
  await client.connect();
  return client;
}
export const handler = async () => {
  const c = await getClient();
  const items = await c.db('app').collection('items').find({}).toArray();
  return { statusCode: 200, body: JSON.stringify(items) };
};`,
  },
  notes: [
    'MasterUsername é SEMPRE "docdbadmin" (fixado pelo synth) — NÃO existe ref("AppDocDb","Username"); hardcode a constante, não é secret',
    'DB_PASSWORD: ref("AppDocDb","Password") — dynamic reference {{resolve:secretsmanager}} injetado pelo CloudFormation, NUNCA chamar Secrets Manager SDK em runtime',
    'retryWrites: false OBRIGATÓRIO — DocumentDB não suporta retryable writes (diferente de MongoDB Atlas/mongodb real); com retryWrites:true (default do driver) toda escrita falha',
    'tlsCAFile aponta pro global-bundle.pem da AWS (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) — precisa estar empacotado junto do código de deploy da Lambda (não é gerado pelo synth)',
    'Database.SQL/DocumentDB exigem ≥2 Availability Zones distintas nas subnets — mesma regra do RDS (validate.ts trata os dois tipos igual)',
    'DocDbSG com ingressRules liberando 27017 SÓ do LambdaSG (sourceSecurityGroupId) — nunca 0.0.0.0/0',
    'DocumentDB NÃO tem tier grátis (db.t3.medium mínimo, ~$0.08/h) — validated:false é decisão de custo, não limitação da ferramenta (synth já comprovado: cluster+instância+secret+exports corretos)',
    'driver "mongodb" (não "mongoose") — collection.find({}).toArray() é suficiente para CRUD simples',
  ],
};
