import { ref, type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

export interface LambdaRefs {
  readonly arn: Ref<'Arn'>;
}

export interface FunctionLambdaProps {
  runtime: 'nodejs20' | 'nodejs18' | 'python3.12' | 'python3.11' | 'java21' | 'go1.x' | 'dotnet8';
  handler: string;
  code: string;
  memory?: number;
  timeout?: number;
  environment?: Record<string, string | Ref>;
  reservedConcurrency?: number;
  layerArns?: string[];
  vpcId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  /** Aciona esta Lambda a partir de uma fila SQS/Pub/Sub, stream Kinesis ou evento de bucket Storage.
   *  queueId = id de um Messaging.Queue; streamId = id de um Messaging.Stream (Kinesis);
   *  bucketId = id de um Storage.Bucket (evento de objeto criado). */
  eventSources?: Array<{
    queueId?: string | Ref<'Arn'>;
    streamId?: string | Ref<'Arn'>;
    bucketId?: string;
    batchSize?: number;
    /** Kinesis: de onde começar a ler. Default 'LATEST'. */
    startingPosition?: 'LATEST' | 'TRIM_HORIZON';
    bisectBatchOnFunctionError?: boolean;
    maxBatchingWindowSeconds?: number;
  }>;
}

/**
 * Autorização de uma API — contrato EXPLÍCITO e verificável (2026-08-01).
 *
 * O contrato antigo (`authType: 'JWT' | 'AWS_IAM' | 'COGNITO'`) não carregava os
 * dados que uma validação real exige (issuer, audiences, jwks) e cada provider
 * implementava uma profundidade diferente — na prática, pedir 'JWT' podia
 * resultar em endpoint PÚBLICO (auditoria de segurança 2026-07-31, achado P0-01).
 *
 * Regra desta API: o provider implementa a semântica pedida ou o synth FALHA.
 * Nunca há downgrade silencioso para público — para expor de propósito, o
 * usuário escreve `auth: { type: 'none' }`.
 */
export type ApiAuth =
  /** Público de propósito — a única forma de gerar uma API sem autorização. */
  | { type: 'none' }
  /**
   * JWT validado pelo próprio gateway. `issuer` e `audiences` são obrigatórios;
   * `jwksUri` é exigido pelo GCP (o AWS HTTP API descobre pelo issuer).
   * Suportado em: AWS (type: 'HTTP'), Azure (APIM) e GCP (API Gateway).
   */
  | { type: 'jwt'; issuer: string; audiences: string[]; jwksUri?: string }
  /** Authorizer customizado (uma Fn.Lambda valida o request). AWS e Azure. */
  | { type: 'lambda'; authorizerLambdaId: string }
  /** Assinatura SigV4 do chamador (AWS_IAM). Só AWS. */
  | { type: 'iam' };

export interface FunctionApiGatewayProps {
  name: string;
  description?: string;
  type?: 'REST' | 'HTTP' | 'WEBSOCKET';
  stageName?: string;
  cors?: boolean;
  /**
   * Autorização da API inteira (pode ser sobrescrita por rota). Preferir sempre
   * este campo — `authType`/`authorizerLambdaId` são o contrato legado.
   */
  auth?: ApiAuth;
  /** @deprecated Use `auth`. Mantido para compatibilidade; normalizado por normalizeApiAuth(). */
  authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO';
  /** @deprecated Use `auth: { type: 'lambda', authorizerLambdaId }`. */
  authorizerLambdaId?: string;
  throttlingBurstLimit?: number;
  throttlingRateLimit?: number;
  /** Associa um Network.WAF (REGIONAL) a este API Gateway REST — id do construct Network.WAF. */
  wafAclId?: string;
  routes?: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'ANY';
    path: string;
    lambdaId?: string;
    description?: string;
    /** Autorização desta rota — sobrepõe a do gateway. */
    auth?: ApiAuth;
    /** @deprecated Use `auth`. */
    authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO';
    /** @deprecated Use `auth: { type: 'lambda', authorizerLambdaId }`. */
    authorizerLambdaId?: string;
  }>;
}

export namespace Fn {
  export class Lambda implements BaseConstruct, LambdaRefs {
    readonly type = 'Function.Lambda';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: FunctionLambdaProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get arn(): Ref<'Arn'> { return ref(this.id, 'Arn'); }
  }

  export class ApiGateway implements BaseConstruct {
    readonly type = 'Function.ApiGateway';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: FunctionApiGatewayProps) {
      if (!props.name)
        throw new Error(`Fn.ApiGateway "${id}": name é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
