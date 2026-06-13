import { Stack, BaseConstruct } from '../stack';

export interface FunctionLambdaProps {
  runtime: 'nodejs20';
  handler: string;
  code: string;
  memory?: number;
  timeout?: number;
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
}
