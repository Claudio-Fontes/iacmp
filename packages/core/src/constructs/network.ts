import { Stack, BaseConstruct } from '../stack';

export interface NetworkVPCProps {
  cidr?: string;
  maxAzs?: number;
}

export namespace Network {
  export class VPC implements BaseConstruct {
    readonly type = 'Network.VPC';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: NetworkVPCProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
