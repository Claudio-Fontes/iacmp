import { Stack, BaseConstruct } from '../stack';

export interface ComputeInstanceProps {
  instanceType: 'small' | 'medium' | 'large';
  image: string;
  region?: string;
}

export namespace Compute {
  export class Instance implements BaseConstruct {
    readonly type = 'Compute.Instance';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: ComputeInstanceProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
