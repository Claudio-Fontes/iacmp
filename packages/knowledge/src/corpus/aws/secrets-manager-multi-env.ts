import type { Example } from '../index.js';

export const secretsManagerApiKey: Example = {
  id: 'aws-secrets-manager-multi-env-config',
  title: 'Secrets Manager multi-ambiente: GET /config?env=dev filtra campos sensíveis',
  tags: ['aws', 'secrets', 'secrets-manager', 'lambda', 'config', 'multi-ambiente', 'api-gateway'],
  // validado em deploy real (bateria ciclo 18): GET /config?env=dev filtra password/token do
  // retorno; env inválido -> 400. Sem fix de ferramenta (Secret.Vault+Lambda+ApiGateway já corretos)
  validated: true,
  stacks: {
    'stacks/secret/vault-stack.ts': `import { Stack, Secret } from '@iacmp/core';
const stack = new Stack('app-config-secrets');
// Um Secret.Vault POR AMBIENTE — cada um gerado pelo Secrets Manager (GenerateSecretString).
new Secret.Vault(stack, 'DevConfigSecret',     { description: 'Config sensível do ambiente dev' });
new Secret.Vault(stack, 'StagingConfigSecret', { description: 'Config sensível do ambiente staging' });
new Secret.Vault(stack, 'ProdConfigSecret',    { description: 'Config sensível do ambiente prod' });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('app-config-api');
new Fn.Lambda(stack, 'GetConfigFn', {
  runtime: 'nodejs20',
  handler: 'dist/getConfig.handler',
  code: '.',
  environment: {
    DEV_SECRET_ARN:     ref('DevConfigSecret', 'Arn'),
    STAGING_SECRET_ARN: ref('StagingConfigSecret', 'Arn'),
    PROD_SECRET_ARN:    ref('ProdConfigSecret', 'Arn'),
  },
});
new Policy.IAM(stack, 'GetConfigFnPolicy', {
  attachTo: 'GetConfigFn', attachType: 'lambda',
  statements: [{
    effect: 'Allow',
    actions: ['secretsmanager:GetSecretValue'],
    resources: [ref('DevConfigSecret', 'Arn'), ref('StagingConfigSecret', 'Arn'), ref('ProdConfigSecret', 'Arn')],
  }],
});
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('app-config-gw');
new Fn.ApiGateway(stack, 'ConfigApi', {
  name: 'config-api', type: 'HTTP', cors: true,
  routes: [
    { method: 'GET', path: '/config', lambdaId: 'GetConfigFn' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/getConfig.ts': `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
const client = new SecretsManagerClient({});

const SECRET_ARN_BY_ENV: Record<string, string | undefined> = {
  dev: process.env.DEV_SECRET_ARN,
  staging: process.env.STAGING_SECRET_ARN,
  prod: process.env.PROD_SECRET_ARN,
};

// Campos sensíveis NUNCA saem no corpo da resposta — só usados internamente
// (ex: para autenticar contra outro serviço), nunca expostos ao cliente da API.
const SENSITIVE_FIELDS = ['password', 'token'];

export const handler = async (event: any) => {
  const env = event.queryStringParameters?.env;
  const secretArn = env ? SECRET_ARN_BY_ENV[env] : undefined;
  if (!env || !secretArn) {
    return { statusCode: 400, body: JSON.stringify({ error: 'env inválido — use dev, staging ou prod' }) };
  }
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const raw = JSON.parse(res.SecretString ?? '{}');
  const filtered = Object.fromEntries(Object.entries(raw).filter(([k]) => !SENSITIVE_FIELDS.includes(k)));
  return { statusCode: 200, body: JSON.stringify({ env, config: filtered }) };
};`,
  },
  notes: [
    'Secret.Vault SEMPRE gera o valor automaticamente (GenerateSecretString, 32 chars, sem pontuação) — NÃO existe prop "value"/"secretString" para setar o conteúdo na criação',
    'Secret.Vault só expõe ref(id,"Arn")/ref(id,"SecretArn") — NÃO existe ref para o valor em si; a Lambda busca em runtime via GetSecretValueCommand',
    'Um Secret.Vault POR AMBIENTE (Dev/Staging/Prod) na MESMA stack — "multi-ambiente" aqui é uma única API que seleciona o secret certo por query param, não 3 deploys separados',
    'Policy.IAM com secretsmanager:GetSecretValue nos 3 ARNs explícitos — NUNCA Resource:"*"',
    'env inválido (fora de dev/staging/prod) OU sem query param -> 400 ANTES de qualquer chamada ao Secrets Manager',
    'SENSITIVE_FIELDS filtrados do corpo da resposta — password/token nunca vazam pro cliente da API, mesmo que estejam no JSON do secret',
    'DEV_SECRET_ARN/STAGING_SECRET_ARN/PROD_SECRET_ARN via ref(...) — NUNCA ARN literal',
  ],
};
