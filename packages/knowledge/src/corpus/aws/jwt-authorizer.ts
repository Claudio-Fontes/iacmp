import type { Example } from '../index.js';

export const jwtAuthorizer: Example = {
  id: 'aws-jwt-authorizer',
  title: 'API HTTP com Lambda Authorizer validando JWT',
  tags: ['aws', 'jwt', 'authorizer', 'lambda', 'api-gateway', 'secrets-manager'],
  // validado em deploy real (ciclo 12 da bateria): Lambda authorizer JWT
  validated: true,
  stacks: {
    'stacks/secret/jwt-secret-stack.ts': `import { Stack, Secret } from '@iacmp/core';
const stack = new Stack('jwt-secret');
new Secret.Vault(stack, 'JwtSigningSecret', { description: 'Chave de assinatura dos JWT emitidos pelo login' });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('profile-api');
new Fn.Lambda(stack, 'JwtAuthorizerFn', {
  runtime: 'nodejs20',
  handler: 'dist/jwtAuthorizer.handler',
  code: '.',
  environment: { JWT_SECRET_ARN: ref('JwtSigningSecret', 'Arn') },
});
new Policy.IAM(stack, 'JwtAuthorizerFnPolicy', {
  attachTo: 'JwtAuthorizerFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['secretsmanager:GetSecretValue'], resources: [ref('JwtSigningSecret', 'Arn')] }],
});
new Fn.Lambda(stack, 'GetProfileFn', { runtime: 'nodejs20', handler: 'dist/getProfile.handler', code: '.' });
new Fn.Lambda(stack, 'PublicHealthFn', { runtime: 'nodejs20', handler: 'dist/publicHealth.handler', code: '.' });
export default stack;`,

    'stacks/network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('profile-gw');
new Fn.ApiGateway(stack, 'ProfileApi', {
  name: 'profile-api', type: 'HTTP', cors: true,
  authType: 'JWT',
  authorizerLambdaId: 'JwtAuthorizerFn',
  routes: [
    { method: 'GET', path: '/profile', lambdaId: 'GetProfileFn' },
    { method: 'GET', path: '/health', lambdaId: 'PublicHealthFn', authType: 'NONE' },
  ],
});
export default stack;`,
  },
  handlers: {
    'src/jwtAuthorizer.ts': `import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import jwt from 'jsonwebtoken';

const client = new SecretsManagerClient({});
let cachedSecret: string | undefined;
async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await client.send(new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET_ARN }));
  cachedSecret = res.SecretString ?? '';
  return cachedSecret;
}

// Lambda Authorizer HTTP API v2 com EnableSimpleResponses — retorna
// { isAuthorized, context }, NUNCA o formato de IAM policy (isso é só REST/v1).
export const handler = async (event: any) => {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  const token = authHeader?.replace(/^Bearer\\s+/i, '');
  if (!token) return { isAuthorized: false };
  try {
    const secret = await getSigningSecret();
    const payload = jwt.verify(token, secret) as { sub: string };
    return { isAuthorized: true, context: { sub: payload.sub } };
  } catch {
    return { isAuthorized: false };
  }
};`,
    'src/getProfile.ts': `export const handler = async (event: any) => {
  // Contexto do authorizer chega em requestContext.authorizer.lambda (payload format 2.0)
  const sub = event.requestContext?.authorizer?.lambda?.sub;
  return { statusCode: 200, body: JSON.stringify({ userId: sub }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
    'src/publicHealth.ts': `export const handler = async () => {
  return { statusCode: 200, body: JSON.stringify({ ok: true }), headers: { 'Access-Control-Allow-Origin': '*' } };
};`,
  },
  notes: [
    'type:"HTTP" (ApiGatewayV2) → o authorizer vira AuthorizerType:"REQUEST" com EnableSimpleResponses:true — o handler retorna { isAuthorized, context }, NUNCA o formato de IAM policy (policyDocument) que é EXCLUSIVO de type:"REST" (TOKEN authorizer)',
    'authType:"JWT" no nível do gateway + authorizerLambdaId — todo route herda o authorizer, EXCETO o que declara authType:"NONE" explicitamente (rota pública, ex: /health)',
    'context retornado pelo authorizer chega no Lambda de destino em event.requestContext.authorizer.lambda.<chave> — NUNCA event.requestContext.authorizer.<chave> direto (isso é o formato do REST/TOKEN)',
    'JwtAuthorizerFn PRECISA de Policy.IAM com secretsmanager:GetSecretValue — sem ela AccessDeniedException ao validar o primeiro token',
    'Cache do secret em module scope (fora do handler) — evita 1 GetSecretValue por invocação de autorização',
    'authorizerLambdaId (gateway) e authType:"NONE" por rota são MUTUAMENTE COMPLEMENTARES — declarar authorizerLambdaId não torna TODAS as rotas protegidas automaticamente, só as que não têm authType:"NONE"',
    'Nenhuma AWS::Lambda::Permission manual necessária — o synth cria a permission de apigateway.amazonaws.com pra TODA Lambda referenciada (rotas E authorizer) automaticamente',
  ],
};
