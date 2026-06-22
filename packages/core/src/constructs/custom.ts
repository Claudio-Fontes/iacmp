import { Stack, BaseConstruct } from '../stack';

export interface CustomResourceProps {
  description?: string;
  cloudformation?: { type: string; properties: Record<string, unknown> };
  arm?: { type: string; apiVersion: string; properties: Record<string, unknown>; sku?: Record<string, unknown>; kind?: string };
  deploymentManager?: { type: string; properties: Record<string, unknown> };
  terraform?: { type: string; body: Record<string, unknown> };
}

export namespace Custom {
  export class Resource implements BaseConstruct {
    readonly type = 'Custom.Resource';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: CustomResourceProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
