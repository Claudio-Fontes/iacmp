import { Stack, BaseConstruct } from '../stack';

export interface ComputeInstanceProps {
  instanceType: 'small' | 'medium' | 'large';
  image: string;
  region?: string;
  subnetId?: string;
  securityGroupIds?: string[];
}

export interface ComputeAutoScalingProps {
  instanceType: 'small' | 'medium' | 'large';
  image: string;
  minCapacity: number;
  maxCapacity: number;
  desiredCapacity?: number;
  targetCpuUtilization?: number;
  subnetIds?: string[];
  securityGroupIds?: string[];
  healthCheckPath?: string;
  healthCheckPort?: number;
}

export interface ComputeContainerProps {
  image: string;
  cpu?: number;
  memory?: number;
  port?: number;
  environment?: Record<string, string>;
  desiredCount?: number;
  publicIp?: boolean;
  subnetIds?: string[];
  securityGroupIds?: string[];
}

export interface ComputeKubernetesProps {
  version?: string;
  nodeInstanceType?: 'small' | 'medium' | 'large';
  minNodes?: number;
  maxNodes?: number;
  desiredNodes?: number;
  privateCluster?: boolean;
  subnetIds?: string[];
  securityGroupIds?: string[];
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

  export class AutoScaling implements BaseConstruct {
    readonly type = 'Compute.AutoScaling';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: ComputeAutoScalingProps) {
      if (props.minCapacity < 0)
        throw new Error(`Compute.AutoScaling "${id}": minCapacity deve ser >= 0`);
      if (props.maxCapacity < props.minCapacity)
        throw new Error(`Compute.AutoScaling "${id}": maxCapacity deve ser >= minCapacity`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Container implements BaseConstruct {
    readonly type = 'Compute.Container';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: ComputeContainerProps) {
      if (!props.image)
        throw new Error(`Compute.Container "${id}": image é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Kubernetes implements BaseConstruct {
    readonly type = 'Compute.Kubernetes';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: ComputeKubernetesProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
