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
  /** Ingress: libera acesso a partir de OUTRO security group (id lógico). Tem precedência sobre cidr. */
  sourceSecurityGroupId?: string;
  /** Egress: libera saída para OUTRO security group (id lógico). */
  destinationSecurityGroupId?: string;
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
  /** Rate-based: máximo de requisições por IP numa janela de 5 min (ex: 100). */
  rateLimit?: number;
  description?: string;
}

export interface NetworkWAFProps {
  scope?: 'REGIONAL' | 'CLOUDFRONT';
  defaultAction?: 'allow' | 'block';
  mode?: 'Detection' | 'Prevention';
  rules?: WAFRule[];
  description?: string;
}

export interface NetworkLoadBalancerProps {
  type?: 'application' | 'network';
  scheme?: 'internet-facing' | 'internal';
  vpcId: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  deletionProtection?: boolean;
  listeners?: Array<{
    port: number;
    protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'TLS';
    certificateArn?: string;
    redirectToHttps?: boolean;
  }>;
  targetGroups?: Array<{
    name: string;
    port: number;
    protocol: 'HTTP' | 'HTTPS' | 'TCP';
    healthCheckPath?: string;
    healthCheckPort?: number;
  }>;
}

export interface NetworkCDNProps {
  origins: Array<{
    domainName: string;
    id: string;
    path?: string;
    protocol?: 'http-only' | 'https-only' | 'match-viewer';
    bucketRef?: string;
  }>;
  defaultRootObject?: string;
  priceClass?: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All';
  httpVersion?: 'http1.1' | 'http2' | 'http2and3';
  wafAclId?: string;
  aliases?: string[];
  certificateArn?: string;
  cachePolicies?: Array<{
    pathPattern: string;
    ttlSeconds?: number;
    compress?: boolean;
  }>;
}

export interface NetworkVpcEndpointProps {
  vpcId: string;
  /** Serviços AWS acessados via Gateway Endpoint (grátis). */
  services: Array<'dynamodb' | 's3'>;
  /** Subnets privadas cujo tráfego deve rotear pelo endpoint (o synth cria a route table e associa). */
  subnetIds: string[];
}

export interface NetworkDnsProps {
  zoneName: string;
  records: Array<{
    name: string;
    type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'PTR' | 'SRV';
    ttl?: number;
    values: string[];
    aliasTarget?: string;
  }>;
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

  export class LoadBalancer implements BaseConstruct {
    readonly type = 'Network.LoadBalancer';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: NetworkLoadBalancerProps) {
      if (!props.vpcId) throw new Error(`Network.LoadBalancer "${id}": vpcId é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class CDN implements BaseConstruct {
    readonly type = 'Network.CDN';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: NetworkCDNProps) {
      if (!props.origins || props.origins.length === 0)
        throw new Error(`Network.CDN "${id}": origins não pode ser vazio`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class VpcEndpoint implements BaseConstruct {
    readonly type = 'Network.VpcEndpoint';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: NetworkVpcEndpointProps) {
      if (!props.vpcId) throw new Error(`Network.VpcEndpoint "${id}": vpcId é obrigatório`);
      if (!props.services || props.services.length === 0)
        throw new Error(`Network.VpcEndpoint "${id}": services não pode ser vazio`);
      if (!props.subnetIds || props.subnetIds.length === 0)
        throw new Error(`Network.VpcEndpoint "${id}": subnetIds não pode ser vazio`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Dns implements BaseConstruct {
    readonly type = 'Network.Dns';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: NetworkDnsProps) {
      if (!props.zoneName) throw new Error(`Network.Dns "${id}": zoneName é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
