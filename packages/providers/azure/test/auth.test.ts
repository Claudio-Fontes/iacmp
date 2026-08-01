import { Stack, Fn } from '@iacmp/core';
import { AzureProvider } from '../src';

/**
 * Auth no Azure (auditoria P0-01): o APIM agora valida JWT contra o
 * openid-config do issuer, e CORS deixou de descartar a validação (eram
 * branches mutuamente exclusivos: pedir cors:true removia o validate-jwt).
 */
describe('Azure — auth no APIM', () => {
  const provider = new AzureProvider();
  let stack: Stack;

  beforeEach(() => {
    stack = new Stack('auth-az', { region: 'eastus2' });
    new Fn.Lambda(stack, 'ApiFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
  });

  const bicep = () => provider.synthesize(stack, [stack]) as unknown as string;

  it('jwt → policy validate-jwt com openid-config, issuer e audiences', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: { type: 'jwt', issuer: 'https://login.microsoftonline.com/tid/v2.0', audiences: ['api://minha-api'] },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    const out = bicep();
    expect(out).toContain('validate-jwt');
    expect(out).toContain('openid-config');
    expect(out).toContain('https://login.microsoftonline.com/tid/v2.0');
    expect(out).toContain('api://minha-api');
  });

  it('cors + jwt convivem na mesma policy (antes o cors descartava o jwt)', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      cors: true,
      auth: { type: 'jwt', issuer: 'https://idp/', audiences: ['a'] },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    const out = bicep();
    expect(out).toContain('validate-jwt');
    expect(out).toContain('<cors');
  });

  it('iam (SigV4) FALHA — não existe equivalente no Azure', () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      auth: { type: 'iam' },
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    expect(() => bicep()).toThrow(/não é suportado|SigV4/);
  });

  it("legado authType: 'JWT' sem authorizer FALHA (não vira API aberta)", () => {
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      authType: 'JWT',
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
    } as never);
    expect(() => bicep()).toThrow(/issuer, audiences/);
  });
});
