/** União fechada de todos os tipos de construct. */
export type ConstructType =
  | 'Cache.Redis'
  | 'Cache.Memcached'
  | 'Certificate.TLS'
  | 'Compute.AutoScaling'
  | 'Compute.Container'
  | 'Compute.Instance'
  | 'Compute.Kubernetes'
  | 'Custom.Resource'
  | 'Database.DocumentDB'
  | 'Database.DynamoDB'
  | 'Database.SQL'
  | 'Events.EventBridge'
  | 'Function.ApiGateway'
  | 'Function.Lambda'
  | 'Logging.Stream'
  | 'Messaging.Queue'
  | 'Messaging.Stream'
  | 'Messaging.Topic'
  | 'Monitoring.Alarm'
  | 'Monitoring.Dashboard'
  | 'Network.CDN'
  | 'Network.Dns'
  | 'Network.LoadBalancer'
  | 'Network.SecurityGroup'
  | 'Network.Subnet'
  | 'Network.VPC'
  | 'Network.VpcEndpoint'
  | 'Network.WAF'
  | 'Policy.IAM'
  | 'Secret.Vault'
  | 'Storage.Archive'
  | 'Storage.Bucket'
  | 'Storage.FileSystem'
  | 'Workflow.StepFunctions';

export type AnchorLayer =
  | 'cache'
  | 'compute'
  | 'database'
  | 'messaging'
  | 'network'
  | 'security'
  | 'storage';

export interface DiagramMeta {
  emoji: string;
  technology: string;
  techByProvider?: Partial<Record<'aws' | 'azure' | 'gcp', string>>;
}

export interface ConstructTypeInfo {
  /** Camada âncora para validateSemantics. null = não é âncora. */
  layer: AnchorLayer | null;
  diagram: DiagramMeta;
  /** Atributos referenciáveis via ref(). */
  attributes: ReadonlyArray<string>;
}

export const CONSTRUCT_TYPES: Record<ConstructType, ConstructTypeInfo> = {
  'Cache.Redis': {
    layer: 'cache',
    diagram: { emoji: '⚡', technology: 'Redis Cache' },
    attributes: ['Endpoint', 'Port'],
  },
  'Cache.Memcached': {
    layer: 'cache',
    diagram: { emoji: '⚡', technology: 'Memcached Cache' },
    attributes: [],
  },
  'Certificate.TLS': {
    layer: 'security',
    diagram: {
      emoji: '🔏',
      technology: 'TLS Certificate',
      techByProvider: {
        aws: 'TLS Certificate (ACM)',
        azure: 'TLS Certificate (Key Vault)',
        gcp: 'TLS Certificate',
      },
    },
    attributes: [],
  },
  'Compute.AutoScaling': {
    layer: 'compute',
    diagram: { emoji: '⚙️', technology: 'Auto Scaling Group' },
    attributes: [],
  },
  'Compute.Container': {
    layer: 'compute',
    diagram: {
      emoji: '📦',
      technology: 'Container',
      techByProvider: {
        aws: 'Container (ECS/Fargate)',
        azure: 'Container Instances',
        gcp: 'Cloud Run',
      },
    },
    attributes: [],
  },
  'Compute.Instance': {
    layer: 'compute',
    diagram: { emoji: '⚙️', technology: 'Virtual Machine' },
    attributes: [],
  },
  'Compute.Kubernetes': {
    layer: 'compute',
    diagram: {
      emoji: '☸️',
      technology: 'Kubernetes',
      techByProvider: {
        aws: 'Kubernetes (EKS)',
        azure: 'Kubernetes Service (AKS)',
        gcp: 'Kubernetes Engine (GKE)',
      },
    },
    attributes: [],
  },
  'Custom.Resource': {
    layer: null,
    diagram: { emoji: '□', technology: 'Custom.Resource' },
    attributes: [],
  },
  'Database.DocumentDB': {
    layer: 'database',
    diagram: { emoji: '📄', technology: 'Document DB' },
    attributes: ['Endpoint', 'Port', 'SecretArn', 'Password'],
  },
  'Database.DynamoDB': {
    layer: 'database',
    diagram: {
      emoji: '⚡',
      technology: 'NoSQL Database',
      techByProvider: {
        aws: 'DynamoDB',
        azure: 'Table Storage',
        gcp: 'Bigtable',
      },
    },
    attributes: ['Arn', 'Name'],
  },
  'Database.SQL': {
    layer: 'database',
    diagram: { emoji: '🗄️', technology: 'Relational DB' },
    attributes: ['Endpoint', 'Port', 'SecretArn', 'Password', 'Username'],
  },
  'Events.EventBridge': {
    layer: 'messaging',
    diagram: { emoji: '📡', technology: 'Event Bus' },
    attributes: [],
  },
  'Function.ApiGateway': {
    layer: 'network',
    diagram: {
      emoji: '🔌',
      technology: 'API Gateway',
      techByProvider: {
        aws: 'API Gateway',
        azure: 'API Management',
        gcp: 'Cloud Endpoints',
      },
    },
    attributes: [],
  },
  'Function.Lambda': {
    layer: 'compute',
    diagram: { emoji: '⚡', technology: 'Serverless' },
    attributes: ['Arn'],
  },
  'Logging.Stream': {
    layer: null,
    diagram: {
      emoji: '📋',
      technology: 'Log Stream',
      techByProvider: {
        aws: 'CloudWatch Logs',
        azure: 'Log Analytics',
        gcp: 'Cloud Logging',
      },
    },
    attributes: [],
  },
  'Messaging.Queue': {
    layer: 'messaging',
    diagram: {
      emoji: '📨',
      technology: 'Queue',
      techByProvider: {
        aws: 'Queue (SQS)',
        azure: 'Queue (Service Bus)',
        gcp: 'Pub/Sub Queue',
      },
    },
    attributes: ['Arn', 'QueueUrl', 'QueueArn'],
  },
  'Messaging.Stream': {
    layer: 'messaging',
    diagram: {
      emoji: '🌊',
      technology: 'Stream',
      techByProvider: {
        aws: 'Stream (Kinesis)',
        azure: 'Event Hub',
      },
    },
    attributes: ['Arn', 'Name'],
  },
  'Messaging.Topic': {
    layer: 'messaging',
    diagram: {
      emoji: '📢',
      technology: 'Topic',
      techByProvider: {
        aws: 'Topic (SNS)',
        azure: 'Topic (Service Bus)',
        gcp: 'Pub/Sub Topic',
      },
    },
    attributes: ['Arn', 'TopicArn'],
  },
  'Monitoring.Alarm': {
    layer: null,
    diagram: {
      emoji: '🚨',
      technology: 'Monitoring Alarm',
      techByProvider: {
        aws: 'CloudWatch Alarm',
        azure: 'Monitor Alert',
        gcp: 'Cloud Monitoring Alert',
      },
    },
    attributes: [],
  },
  'Monitoring.Dashboard': {
    layer: null,
    diagram: {
      emoji: '📊',
      technology: 'Monitoring Dashboard',
      techByProvider: {
        aws: 'CloudWatch Dashboard',
        azure: 'Monitor Dashboard',
        gcp: 'Cloud Monitoring Dashboard',
      },
    },
    attributes: [],
  },
  'Network.CDN': {
    layer: 'network',
    diagram: {
      emoji: '🌍',
      technology: 'CDN',
      techByProvider: {
        aws: 'CDN (CloudFront)',
        azure: 'CDN Profile',
        gcp: 'Cloud CDN',
      },
    },
    attributes: [],
  },
  'Network.Dns': {
    layer: null,
    diagram: {
      emoji: '🌐',
      technology: 'DNS',
      techByProvider: {
        aws: 'DNS (Route53)',
        azure: 'DNS Zone',
        gcp: 'Cloud DNS',
      },
    },
    attributes: [],
  },
  'Network.LoadBalancer': {
    layer: 'network',
    diagram: { emoji: '⚖️', technology: 'Load Balancer' },
    attributes: ['TargetGroupArn', 'DnsName'],
  },
  'Network.SecurityGroup': {
    layer: null,
    diagram: { emoji: '🛡️', technology: 'Security Group' },
    attributes: ['GroupId'],
  },
  'Network.Subnet': {
    layer: null,
    diagram: {
      emoji: '🔀',
      technology: 'Subnet',
      techByProvider: {
        azure: 'Subnet',
        gcp: 'Subnet',
      },
    },
    attributes: ['SubnetId'],
  },
  'Network.VPC': {
    layer: 'network',
    diagram: {
      emoji: '🌐',
      technology: 'Virtual Network',
      techByProvider: {
        azure: 'Virtual Network (VNet)',
        gcp: 'VPC Network',
      },
    },
    attributes: ['VpcId'],
  },
  'Network.VpcEndpoint': {
    layer: null,
    diagram: { emoji: '□', technology: 'Network.VpcEndpoint' },
    attributes: [],
  },
  'Network.WAF': {
    layer: null,
    diagram: { emoji: '🔒', technology: 'WAF' },
    attributes: ['Arn'],
  },
  'Policy.IAM': {
    layer: null,
    diagram: { emoji: '🔑', technology: 'IAM Policy' },
    attributes: [],
  },
  'Secret.Vault': {
    layer: 'security',
    diagram: { emoji: '🔐', technology: 'Secrets Manager' },
    attributes: ['SecretArn', 'Arn'],
  },
  'Storage.Archive': {
    layer: 'storage',
    diagram: {
      emoji: '🗃️',
      technology: 'Archive Storage',
      techByProvider: {
        aws: 'Archive (Glacier)',
        azure: 'Archive Storage',
        gcp: 'Archive Storage',
      },
    },
    attributes: [],
  },
  'Storage.Bucket': {
    layer: 'storage',
    diagram: { emoji: '🗂️', technology: 'Object Storage' },
    attributes: ['Arn', 'Name'],
  },
  'Storage.FileSystem': {
    layer: 'storage',
    diagram: {
      emoji: '🗄️',
      technology: 'File System',
      techByProvider: {
        aws: 'File System (EFS)',
        azure: 'Azure Files',
        gcp: 'Filestore',
      },
    },
    attributes: [],
  },
  'Workflow.StepFunctions': {
    layer: null,
    diagram: { emoji: '🔄', technology: 'Step Functions' },
    attributes: [],
  },
};
