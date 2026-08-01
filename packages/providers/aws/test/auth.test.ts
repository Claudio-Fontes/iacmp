import { Stack, Fn } from '@iacmp/core';
import { AWSProvider } from '../src';

/**
 * Auth no artefato final (auditoria P0-01): o que sai no CloudFormation precisa
 * corresponder ao que foi pedido — ou o synth falha. Nada de AuthorizationType
 * 'NONE' quando o usuário pediu proteção.
 */
describe('AWS — auth no template final', () => {
  let stack: Stack;
  const provider = new AWSProvider();

  beforeEach(() => {
    stack = new Stack('auth-test', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'ApiFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
  });

  const api = (props: Record<string, unknown>) =>
    new Fn.ApiGateway(stack, 'Api', {
      name: 'api',
      routes: [{ method: 'GET', path: '/items', lambdaId: 'ApiFn' }],
      ...props,
    } as never);

  const routeOf = (tpl: Record<string, never>) =>
    Object.values(tpl.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)
      .find(r => r.Type === 'AWS::ApiGatewayV2::Route')!.Properties;

  it("HTTP + jwt → AWS::ApiGatewayV2::Authorizer do tipo JWT e rota com AuthorizationType 'JWT'", () => {
    api({ type: 'HTTP', auth: { type: 'jwt', issuer: 'https://idp.example/', audiences: ['minha-api'] } });
    const tpl = provider.synthesize(stack) as never as Record<string, never>;
    const authorizer = Object.values(tpl.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)
      .find(r => r.Type === 'AWS::ApiGatewayV2::Authorizer')!;
    expect(authorizer.Properties.AuthorizerType).toBe('JWT');
    expect(authorizer.Properties.JwtConfiguration).toEqual({ Issuer: 'https://idp.example/', Audience: ['minha-api'] });
    expect(routeOf(tpl).AuthorizationType).toBe('JWT');
  });

  it("HTTP + iam → rota com AuthorizationType 'AWS_IAM'", () => {
    api({ type: 'HTTP', auth: { type: 'iam' } });
    const tpl = provider.synthesize(stack) as never as Record<string, never>;
    expect(routeOf(tpl).AuthorizationType).toBe('AWS_IAM');
  });

  it("none explícito → rota pública (sem AuthorizationType de proteção)", () => {
    api({ type: 'HTTP', auth: { type: 'none' } });
    const tpl = provider.synthesize(stack) as never as Record<string, never>;
    expect(routeOf(tpl).AuthorizationType).toBeUndefined();
  });

  it('REST + jwt FALHA (REST não valida JWT nativamente) em vez de gerar API aberta', () => {
    api({ type: 'REST', auth: { type: 'jwt', issuer: 'https://idp/', audiences: ['a'] } });
    expect(() => provider.synthesize(stack)).toThrow(/não é suportado|type: 'HTTP'/);
  });

  it("legado authType: 'JWT' sem authorizer FALHA (antes virava NONE silencioso)", () => {
    api({ type: 'HTTP', authType: 'JWT' });
    expect(() => provider.synthesize(stack)).toThrow(/issuer, audiences/);
  });

  it("REST + iam → AuthorizationType 'AWS_IAM' no método", () => {
    api({ type: 'REST', auth: { type: 'iam' } });
    const tpl = provider.synthesize(stack) as never as Record<string, never>;
    const method = Object.values(tpl.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)
      .find(r => r.Type === 'AWS::ApiGateway::Method')!;
    expect(method.Properties.AuthorizationType).toBe('AWS_IAM');
  });

  it('rota pode abrir explicitamente (auth none) numa API protegida', () => {
    new Fn.Lambda(stack, 'HealthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api2', {
      name: 'api2',
      type: 'HTTP',
      auth: { type: 'jwt', issuer: 'https://idp/', audiences: ['a'] },
      routes: [
        { method: 'GET', path: '/items', lambdaId: 'ApiFn' },
        { method: 'GET', path: '/health', lambdaId: 'HealthFn', auth: { type: 'none' } },
      ],
    } as never);
    const tpl = provider.synthesize(stack) as never as Record<string, never>;
    const routes = Object.entries(tpl.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>)
      .filter(([, r]) => r.Type === 'AWS::ApiGatewayV2::Route');
    const health = routes.find(([id]) => id.includes('health'))!;
    const items = routes.find(([id]) => id.includes('items'))!;
    expect(health[1].Properties.AuthorizationType).toBeUndefined();
    expect(items[1].Properties.AuthorizationType).toBe('JWT');
  });
});
