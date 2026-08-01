import { normalizeApiAuth, validateApiAuth, assertAuthSupported } from '../src/auth';
import type { ApiAuth } from '../src/constructs/function';

/**
 * O contrato de auth existe para impedir o pior caso da auditoria P0-01: pedir
 * proteção e receber uma API pública. Estes testes fixam a regra "ou o provider
 * implementa, ou o synth falha".
 */
describe('normalizeApiAuth — legado → contrato explícito', () => {
  const W = 'Fn.ApiGateway "Api"';

  it('sem nada declarado → none (compatível com o comportamento histórico)', () => {
    expect(normalizeApiAuth({}, W)).toEqual({ type: 'none' });
  });

  it("authType 'NONE' → none", () => {
    expect(normalizeApiAuth({ authType: 'NONE' }, W)).toEqual({ type: 'none' });
  });

  it('authorizerLambdaId (com ou sem authType) → lambda', () => {
    expect(normalizeApiAuth({ authorizerLambdaId: 'AuthFn' }, W)).toEqual({ type: 'lambda', authorizerLambdaId: 'AuthFn' });
    expect(normalizeApiAuth({ authType: 'JWT', authorizerLambdaId: 'AuthFn' }, W)).toEqual({ type: 'lambda', authorizerLambdaId: 'AuthFn' });
  });

  it("authType 'AWS_IAM' → iam", () => {
    expect(normalizeApiAuth({ authType: 'AWS_IAM' }, W)).toEqual({ type: 'iam' });
  });

  it("authType 'JWT' SEM authorizer FALHA (era o caso que virava API pública)", () => {
    expect(() => normalizeApiAuth({ authType: 'JWT' }, W)).toThrow(/issuer, audiences/);
  });

  it("authType 'COGNITO' sem dados de validação FALHA", () => {
    expect(() => normalizeApiAuth({ authType: 'COGNITO' }, W)).toThrow(/não traz os dados/);
  });

  it('auth explícito tem precedência sobre o legado', () => {
    const auth: ApiAuth = { type: 'jwt', issuer: 'https://idp/', audiences: ['api'] };
    expect(normalizeApiAuth({ auth, authType: 'NONE' }, W)).toBe(auth);
  });
});

describe('validateApiAuth — campos obrigatórios', () => {
  const W = 'Fn.ApiGateway "Api"';

  it('jwt sem issuer falha', () => {
    expect(() => validateApiAuth({ type: 'jwt', issuer: '', audiences: ['a'] }, W)).toThrow(/issuer/);
  });

  it('jwt sem audiences falha', () => {
    expect(() => validateApiAuth({ type: 'jwt', issuer: 'https://idp/', audiences: [] }, W)).toThrow(/audiences/);
  });

  it('lambda sem authorizerLambdaId falha', () => {
    expect(() => validateApiAuth({ type: 'lambda' } as ApiAuth, W)).toThrow(/authorizerLambdaId/);
  });

  it('tipo desconhecido falha', () => {
    expect(() => validateApiAuth({ type: 'magic' } as unknown as ApiAuth, W)).toThrow(/desconhecido/);
  });

  it('none e iam são válidos sem campos extras', () => {
    expect(() => validateApiAuth({ type: 'none' }, W)).not.toThrow();
    expect(() => validateApiAuth({ type: 'iam' }, W)).not.toThrow();
  });
});

describe('assertAuthSupported — provider implementa ou falha', () => {
  const W = 'Fn.ApiGateway "Api"';

  it('passa quando o tipo está na lista do provider', () => {
    expect(() => assertAuthSupported({ type: 'jwt', issuer: 'https://i/', audiences: ['a'] }, ['none', 'jwt'], W)).not.toThrow();
  });

  it('falha (não faz downgrade) quando o provider não implementa', () => {
    expect(() => assertAuthSupported({ type: 'iam' }, ['none', 'jwt'], W)).toThrow(/não é suportado/);
    expect(() => assertAuthSupported({ type: 'lambda', authorizerLambdaId: 'F' }, ['none', 'jwt'], W)).toThrow(/deixaria pública/);
  });

  it('inclui a dica do provider na mensagem', () => {
    expect(() => assertAuthSupported({ type: 'iam' }, ['none'], W, 'Use jwt aqui.')).toThrow(/Use jwt aqui/);
  });
});
