import { ApiAuth } from './constructs/function';

/**
 * Normaliza a autorização de uma API (gateway ou rota) para o contrato
 * explícito `ApiAuth`, aceitando o formato legado (`authType` +
 * `authorizerLambdaId`).
 *
 * Por que existe: até 2026-08-01 o único contrato era `authType`, que declarava
 * a INTENÇÃO ('JWT') sem os dados que uma validação real exige (issuer,
 * audiences, jwks). Cada provider preenchia a lacuna de um jeito — e o caminho
 * mais comum era emitir uma API PÚBLICA (achado P0-01 da auditoria de
 * segurança). Aqui a intenção vira um objeto verificável, e o que não puder ser
 * atendido de verdade FALHA no synth (nunca vira público em silêncio).
 *
 * Regras de tradução do legado:
 *   - ausente (e sem authorizerLambdaId) → `none` (compatibilidade: era o
 *     comportamento efetivo — API sem auth declarada nasce pública);
 *   - `NONE` → `none`;
 *   - qualquer authType + `authorizerLambdaId` → `lambda` (o authorizer era o
 *     que de fato protegia, independentemente do rótulo);
 *   - `AWS_IAM` sem authorizer → `iam`;
 *   - `JWT`/`COGNITO` sem authorizer → ERRO: falta issuer/audiences. É
 *     exatamente o caso que gerava endpoint público.
 */
export function normalizeApiAuth(
  props: { auth?: ApiAuth; authType?: string; authorizerLambdaId?: string },
  where: string,
): ApiAuth {
  if (props.auth) {
    validateApiAuth(props.auth, where);
    return props.auth;
  }
  const legacy = props.authType;
  const authorizerLambdaId = props.authorizerLambdaId;
  if (authorizerLambdaId) return { type: 'lambda', authorizerLambdaId };
  if (!legacy || legacy === 'NONE') return { type: 'none' };
  if (legacy === 'AWS_IAM') return { type: 'iam' };
  throw new Error(
    `${where}: authType '${legacy}' não traz os dados necessários para validar tokens ` +
    `(issuer, audiences).\n` +
    `Fix: use o contrato explícito —\n` +
    `  auth: { type: 'jwt', issuer: 'https://seu-idp/', audiences: ['sua-api'], jwksUri: 'https://seu-idp/.well-known/jwks.json' }\n` +
    `ou, se um Lambda faz a validação:\n` +
    `  auth: { type: 'lambda', authorizerLambdaId: 'MeuAuthorizerFn' }\n` +
    `Para expor a API publicamente de propósito: auth: { type: 'none' }.`,
  );
}

/** Valida o conteúdo de um ApiAuth explícito (campos obrigatórios por tipo). */
export function validateApiAuth(auth: ApiAuth, where: string): void {
  switch (auth.type) {
    case 'jwt': {
      if (!auth.issuer || typeof auth.issuer !== 'string') {
        throw new Error(`${where}: auth.type 'jwt' exige 'issuer' (URL do provedor de identidade).`);
      }
      if (!Array.isArray(auth.audiences) || auth.audiences.length === 0) {
        throw new Error(`${where}: auth.type 'jwt' exige 'audiences' (lista não vazia com o identificador da sua API).`);
      }
      return;
    }
    case 'lambda': {
      if (!auth.authorizerLambdaId) {
        throw new Error(`${where}: auth.type 'lambda' exige 'authorizerLambdaId' (id da Fn.Lambda que valida o request).`);
      }
      return;
    }
    case 'none':
    case 'iam':
      return;
    default: {
      const t = (auth as { type?: string }).type;
      throw new Error(`${where}: auth.type '${t}' desconhecido. Use 'none', 'jwt', 'lambda' ou 'iam'.`);
    }
  }
}

/**
 * Falha quando o provider não implementa o tipo de auth pedido. Chamado por cada
 * synth com a lista do que ele realmente sabe fazer — é o que garante "ou o
 * provider implementa, ou o synth falha", nunca um downgrade para público.
 */
export function assertAuthSupported(
  auth: ApiAuth,
  supported: ReadonlyArray<ApiAuth['type']>,
  where: string,
  hint?: string,
): void {
  if (supported.includes(auth.type)) return;
  throw new Error(
    `${where}: auth.type '${auth.type}' não é suportado neste provider/tipo de API.\n` +
    `Suportados aqui: ${supported.join(', ')}.\n` +
    (hint ? `${hint}\n` : '') +
    `O synth falha de propósito: gerar a API sem a proteção pedida a deixaria pública.`,
  );
}
