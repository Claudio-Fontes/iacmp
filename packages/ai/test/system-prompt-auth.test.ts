import { SYSTEM_PROMPT_TEMPLATE } from '../src/prompts/system-prompt';

describe('system-prompt — authType do Fn.ApiGateway', () => {
  test('documenta os valores reais do construct (NONE, JWT, AWS_IAM, COGNITO)', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain(
      "authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO'",
    );
  });

  test('não documenta CUSTOM — esse valor não existe no construct real', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/authType[^\n]*CUSTOM/);
  });

  test('documenta throttlingBurstLimit/throttlingRateLimit no nível raiz (não aninhado)', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('throttlingBurstLimit?: number');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('throttlingRateLimit?: number');
  });

  test('não documenta o formato antigo e errado throttling: { burstLimit, rateLimit }', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/throttling\?:\s*\{\s*burstLimit/);
  });
});

describe('system-prompt — regras de autenticação/OAuth2', () => {
  test('explica que o @iacmp/core não tem construct tipado para provedor de identidade', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/não tem construct tipado para provedor de identidade/);
  });

  test('instrui a nunca inventar Lambdas customizadas de auth sem perguntar o provider', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/NUNCA invente Lambdas customizadas/);
  });

  test('instrui a perguntar qual provedor de identidade antes de gerar código', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/perguntar qual provedor de identidade/);
  });

  test('instrui a editar o Fn.ApiGateway existente ao criar uma Lambda authorizer, mesmo em arquivo separado', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/MESMO QUE o Fn\.ApiGateway já exista em outro arquivo\/stack diferente/);
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/a Lambda fica órfã \(sem nenhuma seta\/relacionamento no diagrama\)/);
  });

  test('instrui a checar antes de responder se toda Lambda authorizer tem um Fn.ApiGateway referenciando ela', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/Antes de responder, confirme mentalmente/);
  });
});

describe('system-prompt — escape hatch Custom.Resource', () => {
  test('instrui a usar Custom.Resource em vez de recusar serviço fora do catálogo', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/Custom\.Resource/);
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/NÃO diga apenas "não existe construct para isso"/);
  });

  test('documenta as 4 chaves de formato nativo (cloudformation, arm, deploymentManager, terraform)', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('cloudformation?: { type: string, properties: Record<string, unknown> }');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain("arm?: { type: string, apiVersion: string, properties: Record<string, unknown>, sku?: Record<string, unknown>, kind?: string }");
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('deploymentManager?: { type: string, properties: Record<string, unknown> }');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('terraform?: { type: string, body: Record<string, unknown> }');
  });
});

describe('system-prompt — coerência ao discordar/corrigir', () => {
  test('proíbe reafirmar que está adequado sem gerar mudança real', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/TEM que conter uma mudança real em "files" ou "deletions"/);
  });

  test('proíbe respostas que se contradizem no mesmo texto', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/NUNCA dê uma explicação que se contradiz/);
  });
});
