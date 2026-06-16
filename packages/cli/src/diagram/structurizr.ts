import { DiagramModel, DiagramNode } from './model';

// Tags do theme AWS — mapeiam para ícones e cores do provider
const AWS_TYPE_TAG: Record<string, string> = {
  'Compute.Instance':      'Amazon Web Services - EC2 Instance',
  'Compute.AutoScaling':   'Amazon Web Services - EC2 Auto Scaling',
  'Compute.Container':     'Amazon Web Services - Elastic Container Service',
  'Compute.Kubernetes':    'Amazon Web Services - Elastic Kubernetes Service',
  'Storage.Bucket':        'Amazon Web Services - Simple Storage Service',
  'Storage.FileSystem':    'Amazon Web Services - Elastic File System',
  'Storage.Archive':       'Amazon Web Services - Simple Storage Service Glacier',
  'Network.VPC':           'Amazon Web Services - VPC Virtual private cloud VPC',
  'Network.Subnet':        'Amazon Web Services - VPC Subnet',
  'Network.SecurityGroup': 'Amazon Web Services - VPC Security Group',
  'Network.WAF':           'Amazon Web Services - WAF',
  'Network.LoadBalancer':  'Amazon Web Services - Elastic Load Balancing',
  'Network.CDN':           'Amazon Web Services - CloudFront',
  'Network.Dns':           'Amazon Web Services - Route 53',
  'Database.SQL':          'Amazon Web Services - RDS',
  'Database.DocumentDB':   'Amazon Web Services - DocumentDB',
  'Database.DynamoDB':     'Amazon Web Services - DynamoDB',
  'Cache.Redis':           'Amazon Web Services - ElastiCache ElastiCache for Redis',
  'Cache.Memcached':       'Amazon Web Services - ElastiCache ElastiCache for Memcached',
  'Function.Lambda':       'Amazon Web Services - Lambda',
  'Function.ApiGateway':   'Amazon Web Services - API Gateway',
  'Policy.IAM':            'Amazon Web Services - Identity and Access Management IAM',
  'Events.EventBridge':    'Amazon Web Services - EventBridge',
  'Workflow.StepFunctions':'Amazon Web Services - Step Functions',
  'Messaging.Queue':       'Amazon Web Services - Simple Queue Service Queue',
  'Messaging.Topic':       'Amazon Web Services - Simple Notification Service Topic',
  'Secret.Vault':          'Amazon Web Services - Secrets Manager',
  'Certificate.TLS':       'Amazon Web Services - Certificate Manager',
  'Monitoring.Alarm':      'Amazon Web Services - CloudWatch Alarm',
  'Monitoring.Dashboard':  'Amazon Web Services - CloudWatch',
  'Logging.Stream':        'Amazon Web Services - CloudWatch Logs',
};

const AZURE_TYPE_TAG: Record<string, string> = {
  'Compute.Instance':      'Microsoft Azure - Virtual Machine',
  'Compute.AutoScaling':   'Microsoft Azure - Virtual Machine Scale Sets',
  'Compute.Container':     'Microsoft Azure - Container Instances',
  'Compute.Kubernetes':    'Microsoft Azure - Kubernetes Services',
  'Storage.Bucket':        'Microsoft Azure - Storage Accounts',
  'Network.VPC':           'Microsoft Azure - Virtual Networks',
  'Network.LoadBalancer':  'Microsoft Azure - Load Balancers',
  'Network.WAF':           'Microsoft Azure - Application Gateway',
  'Network.CDN':           'Microsoft Azure - CDN Profiles',
  'Network.Dns':           'Microsoft Azure - DNS Zones',
  'Database.SQL':          'Microsoft Azure - SQL Database',
  'Database.DocumentDB':   'Microsoft Azure - Azure Cosmos DB',
  'Cache.Redis':           'Microsoft Azure - Cache for Redis',
  'Function.Lambda':       'Microsoft Azure - Function Apps',
  'Function.ApiGateway':   'Microsoft Azure - API Management Services',
  'Messaging.Queue':       'Microsoft Azure - Service Bus',
  'Messaging.Topic':       'Microsoft Azure - Service Bus',
  'Secret.Vault':          'Microsoft Azure - Key Vaults',
  'Monitoring.Dashboard':  'Microsoft Azure - Monitor',
};

const GCP_TYPE_TAG: Record<string, string> = {
  'Compute.Instance':      'Google Cloud Platform - Compute Engine',
  'Compute.Container':     'Google Cloud Platform - Cloud Run',
  'Compute.Kubernetes':    'Google Cloud Platform - Kubernetes Engine',
  'Storage.Bucket':        'Google Cloud Platform - Cloud Storage',
  'Network.VPC':           'Google Cloud Platform - Virtual Private Cloud',
  'Network.LoadBalancer':  'Google Cloud Platform - Cloud Load Balancing',
  'Network.CDN':           'Google Cloud Platform - Cloud CDN',
  'Network.Dns':           'Google Cloud Platform - Cloud DNS',
  'Database.SQL':          'Google Cloud Platform - Cloud SQL',
  'Database.DocumentDB':   'Google Cloud Platform - Firestore',
  'Database.DynamoDB':     'Google Cloud Platform - Bigtable',
  'Cache.Redis':           'Google Cloud Platform - Memorystore',
  'Function.Lambda':       'Google Cloud Platform - Cloud Functions',
  'Function.ApiGateway':   'Google Cloud Platform - Cloud Endpoints',
  'Messaging.Queue':       'Google Cloud Platform - Pub/Sub',
  'Messaging.Topic':       'Google Cloud Platform - Pub/Sub',
  'Secret.Vault':          'Google Cloud Platform - Secret Manager',
  'Monitoring.Dashboard':  'Google Cloud Platform - Cloud Monitoring',
};

const PROVIDER_THEME: Record<string, string> = {
  'aws':       'https://static.structurizr.com/themes/amazon-web-services-2023.01.31/theme.json',
  'azure':     'https://static.structurizr.com/themes/microsoft-azure-2023.01.24/theme.json',
  'gcp':       'https://static.structurizr.com/themes/google-cloud-platform-v1.5/theme.json',
  'terraform': 'https://static.structurizr.com/themes/amazon-web-services-2023.01.31/theme.json',
};

const PROVIDER_TAGS: Record<string, Record<string, string>> = {
  'aws':       AWS_TYPE_TAG,
  'azure':     AZURE_TYPE_TAG,
  'gcp':       GCP_TYPE_TAG,
  'terraform': AWS_TYPE_TAG,
};

function ind(n: number): string {
  return '  '.repeat(n);
}

function containerBlock(node: DiagramNode, depth: number, tagMap: Record<string, string>): string {
  const tag = tagMap[node.constructType] ?? 'Resource';
  const desc = node.description || '';
  const lines = [
    `${ind(depth)}${node.id} = container "${node.label}" "${desc}" "${node.technology}" {`,
    `${ind(depth + 1)}tags "${tag}"`,
    `${ind(depth)}}`,
  ];
  return lines.join('\n');
}

export function renderStructurizr(model: DiagramModel): string {
  const lines: string[] = [];
  const themeUrl = PROVIDER_THEME[model.provider] ?? PROVIDER_THEME['aws'];
  const tagMap = PROVIDER_TAGS[model.provider] ?? AWS_TYPE_TAG;

  lines.push(`workspace "${model.projectName}" {`);
  lines.push('');
  lines.push(`${ind(1)}model {`);
  lines.push(`${ind(2)}${sanitize(model.projectName)} = softwareSystem "${model.projectName}" "Provider: ${model.provider}, Region: ${model.region}" {`);

  for (const stack of model.stacks) {
    lines.push('');
    lines.push(`${ind(3)}group "${stack.name}" {`);
    for (const node of stack.nodes) {
      lines.push(containerBlock(node, 4, tagMap));
    }
    lines.push(`${ind(3)}}`);
  }

  lines.push(`${ind(2)}}`);

  for (const stack of model.stacks) {
    for (const rel of stack.relationships) {
      if (rel.inferred) {
        lines.push(`${ind(2)}${rel.sourceId} -> ${rel.targetId} "[inferred]" "" "Inferred"`);
      } else {
        lines.push(`${ind(2)}${rel.sourceId} -> ${rel.targetId} "${rel.label}"`);
      }
    }
  }

  lines.push(`${ind(1)}}`);
  lines.push('');
  lines.push(`${ind(1)}views {`);

  const sysId = sanitize(model.projectName);
  for (const stack of model.stacks) {
    const viewId = sanitize(`${stack.name}View`);
    lines.push('');
    lines.push(`${ind(2)}container ${sysId} "${viewId}" "${stack.name}" {`);
    lines.push(`${ind(3)}include *`);
    lines.push(`${ind(3)}autoLayout`);
    lines.push(`${ind(2)}}`);
  }

  lines.push('');
  lines.push(`${ind(2)}!theme default`);
  lines.push(`${ind(2)}theme "${themeUrl}"`);
  lines.push('');
  lines.push(`${ind(2)}styles {`);
  lines.push(`${ind(3)}relationship "Inferred" {`);
  lines.push(`${ind(4)}dashed true`);
  lines.push(`${ind(4)}colour #999999`);
  lines.push(`${ind(3)}}`);
  lines.push(`${ind(2)}}`);
  lines.push(`${ind(1)}}`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}
