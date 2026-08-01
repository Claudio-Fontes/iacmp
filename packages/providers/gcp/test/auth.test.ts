import { Stack, Fn } from '@iacmp/core';
import { GCPProvider } from '../src';

/**
 * Auth no GCP (auditoria P0-01): antes, qualquer authType gerava um
 * securityDefinition com ISSUER_PLACEHOLDER (API "protegida" que não validava
 * nada) e TODA function HTTP recebia allUsers — a URL do backend era pública
 * mesmo atrás de um gateway. Estes testes fixam os dois consertos.
 */
describe('GCP — auth do API Gateway', () => {
  const provider = new GCPProvider();
  let stack: Stack;

  beforeEach(() => {
    stack = new Stack('auth-gcp', { region: 'us-central1' });
    new Fn.Lambda(stack, 'ApiFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
  });

  const synth = () => JSON.parse(JSON.stringify(provider.synthesize(stack, [stack])));

  it('jwt com issuer/jwks reais entra no OpenAPI (sem placeholder)', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: {
        type: 'jwt',
        issuer: 'https://securetoken.google.com/p',
        audiences: ['p'],
        jwksUri: 'https://www.googleapis.com/x509/sa',
      },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    const out = JSON.stringify(synth());
    expect(out).toContain('https://securetoken.google.com/p');
    expect(out).not.toContain('ISSUER_PLACEHOLDER');
  });

  it('jwt sem jwksUri FALHA (o gateway do Google precisa do endereço das chaves)', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: { type: 'jwt', issuer: 'https://idp/', audiences: ['a'] },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    expect(() => synth()).toThrow(/jwksUri/);
  });

  it('lambda authorizer FALHA (não existe no GCP — antes era só documentado)', () => {
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      authorizerLambdaId: 'AuthFn',
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    expect(() => synth()).toThrow(/não é suportado|Lambda authorizer/);
  });

  it('backend de rota protegida NÃO recebe allUsers (sem bypass do gateway)', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: {
        type: 'jwt',
        issuer: 'https://idp/',
        audiences: ['a'],
        jwksUri: 'https://idp/jwks',
      },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    const out = JSON.stringify(synth());
    expect(out).not.toContain('apifn_public');
    // A SA dedicada do gateway continua com invoker — é quem chama a function.
    expect(out).toContain('gw_invoker');
  });

  it('backend de rota pública mantém allUsers (function HTTP aberta de propósito)', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: { type: 'none' },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    expect(JSON.stringify(synth())).toContain('apifn_public');
  });
});
