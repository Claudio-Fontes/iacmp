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
  routes?: Array<{
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'ANY';
    path: string;
    lambdaId?: string;
    description?: string;
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
