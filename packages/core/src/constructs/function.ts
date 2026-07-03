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
  /** Aciona esta Lambda a partir de uma fila SQS ou stream Kinesis (event source mapping).
   *  queueId = id de um Messaging.Queue; streamId = id de um Messaging.Stream (Kinesis). */
  eventSources?: Array<{
    queueId?: string | Ref<'Arn'>;
    streamId?: string | Ref<'Arn'>;
    batchSize?: number;
    /** Kinesis: de onde começar a ler. Default 'LATEST'. */
    startingPosition?: 'LATEST' | 'TRIM_HORIZON';
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
