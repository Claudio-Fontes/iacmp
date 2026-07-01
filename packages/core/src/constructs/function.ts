import { Stack, BaseConstruct } from '../stack';

export interface FunctionLambdaProps {
  runtime: 'nodejs20' | 'nodejs18' | 'python3.12' | 'python3.11' | 'java21' | 'go1.x' | 'dotnet8';
  handler: string;
  code: string;
  memory?: number;
  timeout?: number;
  environment?: Record<string, string>;
  reservedConcurrency?: number;
  layerArns?: string[];
  vpcId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  /** Aciona esta Lambda a partir de filas SQS (event source mapping).
   *  queueId = id de um Messaging.Queue (ou ARN literal de fila existente). */
  eventSources?: Array<{
    queueId: string;
    batchSize?: number;
    bisectBatchOnFunctionError?: boolean;
    maxBatchingWindowSeconds?: number;
  }>;
}

export interface FunctionApiGatewayProps {
  name: string;
  description?: string;
  type?: 'REST' | 'HTTP' | 'WEBSOCKET';
  stageName?: string;
  cors?: boolean;
  authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO';
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
    /** Autorização por rota. authType 'NONE' = pública; authorizerLambdaId = protegida por um Lambda authorizer específico. Sobrepõem o nível do gateway. */
    authType?: 'NONE' | 'JWT' | 'AWS_IAM' | 'COGNITO';
    authorizerLambdaId?: string;
  }>;
}

export namespace Fn {
  export class Lambda implements BaseConstruct {
    readonly type = 'Function.Lambda';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: FunctionLambdaProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
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
