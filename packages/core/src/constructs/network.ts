import { Stack, BaseConstruct } from '../stack';

export interface NetworkVPCProps {
  cidr?: string;
  maxAzs?: number;
}

export interface NetworkSubnetProps {
  vpcId: string;
  cidr: string;
  availabilityZone?: string;
  public?: boolean;
}

export interface SecurityGroupRule {
  protocol: 'tcp' | 'udp' | 'icmp' | '-1';
  fromPort: number;
  toPort: number;
  cidr?: string;
  description?: string;
}

export interface NetworkSecurityGroupProps {
  vpcId: string;
  description?: string;
  ingressRules?: SecurityGroupRule[];
  egressRules?: SecurityGroupRule[];
}

export interface WAFRule {
  name: string;
  priority?: number;
  action?: 'allow' | 'block' | 'count';
  managedGroup?: string;
  sourceIps?: string[];
  matchValues?: string[];
  description?: string;
}

export interface NetworkWAFProps {
  scope?: 'REGIONAL' | 'CLOUDFRONT';
  defaultAction?: 'allow' | 'block';
  mode?: 'Detection' | 'Prevention';
  rules?: WAFRule[];
  description?: string;
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

  export class Subnet implements BaseConstruct {
    readonly type = 'Network.Subnet';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: NetworkSubnetProps) {
      if (!props.vpcId) throw new Error(`Network.Subnet "${id}": vpcId é obrigatório`);
      if (!props.cidr) throw new Error(`Network.Subnet "${id}": cidr é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class SecurityGroup implements BaseConstruct {
    readonly type = 'Network.SecurityGroup';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: NetworkSecurityGroupProps) {
      if (!props.vpcId) throw new Error(`Network.SecurityGroup "${id}": vpcId é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class WAF implements BaseConstruct {
    readonly type = 'Network.WAF';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: NetworkWAFProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
