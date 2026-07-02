import { DiagramModel, DiagramNode } from './model';
import {
  AWS_CLOUD_ICON_B64,
  AWS_REGION_ICON_B64,
  AWS_ACCOUNT_ICON_B64,
  AWS_PUBLIC_SUBNET_ICON_B64,
  AWS_PRIVATE_SUBNET_ICON_B64,
} from './aws-icons';

// Tags do theme AWS — mapeiam para ícones e cores do provider
const AWS_TYPE_TAG: Record<string, string> = {
  'Compute.Instance':      'Amazon Web Services - EC2 Instance',
  'Compute.AutoScaling':   'Amazon Web Services - EC2 Auto Scaling',
  'Compute.Container':     'Amazon Web Services - Elastic Container Service',
  'Compute.Kubernetes':    'Amazon Web Services - Elastic Kubernetes Service',
  'Storage.Bucket':        'Amazon Web Services - Simple Storage Service',
  'Storage.FileSystem':    'Amazon Web Services - EFS',
  'Storage.Archive':       'Amazon Web Services - Simple Storage Service Glacier',
  'Network.VPC':           'Amazon Web Services - VPC Virtual private cloud VPC',
  'Network.Subnet':        'Amazon Web Services - VPC Virtual private cloud VPC',
  'Network.SecurityGroup': 'Amazon Web Services - VPC Virtual private cloud VPC',
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
  'Policy.IAM':            'Amazon Web Services - Identity and Access Management',
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
  'Compute.AutoScaling':   'Microsoft Azure - VM Scale Sets',
  'Compute.Container':     'Microsoft Azure - Container Instances',
  'Compute.Kubernetes':    'Microsoft Azure - Kubernetes Services',
  'Storage.Bucket':        'Microsoft Azure - Blob Block',
  'Storage.FileSystem':    'Microsoft Azure - Storage Azure Files',
  'Storage.Archive':       'Microsoft Azure - Storage Accounts',
  'Network.VPC':           'Microsoft Azure - Virtual Networks',
  'Network.Subnet':        'Microsoft Azure - Subnet',
  'Network.SecurityGroup': 'Microsoft Azure - Network Security Groups',
  'Network.LoadBalancer':  'Microsoft Azure - Load Balancers',
  'Network.WAF':           'Microsoft Azure - Application Gateways',
  'Network.CDN':           'Microsoft Azure - CDN Profiles',
  'Network.Dns':           'Microsoft Azure - DNS Zones',
  'Database.SQL':          'Microsoft Azure - SQL Database',
  'Database.DocumentDB':   'Microsoft Azure - Azure Cosmos DB',
  'Database.DynamoDB':     'Microsoft Azure - Table',
  'Cache.Redis':           'Microsoft Azure - Cache Redis',
  'Cache.Memcached':       'Microsoft Azure - Cache Redis',
  'Function.Lambda':       'Microsoft Azure - Function Apps',
  'Function.ApiGateway':   'Microsoft Azure - API Management Services',
  'Policy.IAM':            'Microsoft Azure - Azure Active Directory',
  'Events.EventBridge':    'Microsoft Azure - Event Grid Topics',
  'Workflow.StepFunctions':'Microsoft Azure - Logic Apps',
  'Messaging.Queue':       'Microsoft Azure - Azure Service Bus',
  'Messaging.Topic':       'Microsoft Azure - Azure Service Bus',
  'Secret.Vault':          'Microsoft Azure - Key Vaults',
  'Certificate.TLS':       'Microsoft Azure - Key Vaults',
  'Monitoring.Alarm':      'Microsoft Azure - Monitor',
  'Monitoring.Dashboard':  'Microsoft Azure - Monitor',
  'Logging.Stream':        'Microsoft Azure - Monitor',
};

const GCP_TYPE_TAG: Record<string, string> = {
  'Compute.Instance':      'Google Cloud Platform - Compute Engine',
  'Compute.AutoScaling':   'Google Cloud Platform - Compute Engine',
  'Compute.Container':     'Google Cloud Platform - Cloud Run',
  'Compute.Kubernetes':    'Google Cloud Platform - Kubernetes Engine',
  'Storage.Bucket':        'Google Cloud Platform - Cloud Storage',
  'Storage.FileSystem':    'Google Cloud Platform - Cloud Filestore',
  'Storage.Archive':       'Google Cloud Platform - Cloud Storage',
  'Network.VPC':           'Google Cloud Platform - Virtual Private Cloud',
  'Network.Subnet':        'Google Cloud Platform - Virtual Private Cloud',
  'Network.SecurityGroup': 'Google Cloud Platform - Cloud Firewall Rules',
  'Network.WAF':           'Google Cloud Platform - Cloud Armor',
  'Network.LoadBalancer':  'Google Cloud Platform - Cloud Load Balancing',
  'Network.CDN':           'Google Cloud Platform - Cloud CDN',
  'Network.Dns':           'Google Cloud Platform - Cloud DNS',
  'Database.SQL':          'Google Cloud Platform - Cloud SQL',
  'Database.DocumentDB':   'Google Cloud Platform - Cloud Firestore',
  'Database.DynamoDB':     'Google Cloud Platform - Cloud Bigtable',
  'Cache.Redis':           'Google Cloud Platform - Cloud Memorystore',
  'Cache.Memcached':       'Google Cloud Platform - Cloud Memorystore',
  'Function.Lambda':       'Google Cloud Platform - Cloud Functions',
  'Function.ApiGateway':   'Google Cloud Platform - Cloud Endpoints',
  'Policy.IAM':            'Google Cloud Platform - Cloud IAM',
  'Events.EventBridge':    'Google Cloud Platform - Cloud PubSub',
  'Workflow.StepFunctions':'Google Cloud Platform - Cloud Tasks',
  'Messaging.Queue':       'Google Cloud Platform - Cloud PubSub',
  'Messaging.Topic':       'Google Cloud Platform - Cloud PubSub',
  'Secret.Vault':          'Google Cloud Platform - Key Management Service',
  'Certificate.TLS':       'Google Cloud Platform - Key Management Service',
  'Monitoring.Alarm':      'Google Cloud Platform - Monitoring',
  'Monitoring.Dashboard':  'Google Cloud Platform - Monitoring',
  'Logging.Stream':        'Google Cloud Platform - Logging',
};

// Themes servidos por static.structurizr.com (CORS liberado, "access-control-
// allow-origin: *") — confirmado via curl. As versões mais novas (AWS 2025.07,
// Azure 2025.11) só existem em playground.structurizr.com, que NÃO libera CORS
// (sem o header access-control-allow-origin), então o DSL Editor em
// structurizr.com/dsl bloqueia o fetch do theme.json no browser e nenhum ícone
// é aplicado — confirmado: o usuário testou e o ícone não apareceu. Por isso
// ficamos no CDN antigo, que é o único com entrega garantida no editor.
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

// Metadados da deployment view por provider — nomes do cloud/region, a
// nomenclatura nativa de rede (VPC na AWS, VNet no Azure, VPC network no GCP)
// e a tag de view usada pelo theme do Structurizr.
interface ProviderDeploymentMeta {
  cloud: string;
  cloudTech: string;
  regionTech: string;
  viewTag: string;
  networkLabel: string;   // ex: "VPC", "VNet", "VPC Network"
  networkTech: string;    // ex: "Virtual Private Cloud", "Virtual Network"
  publicSubnetLabel: string;
  privateSubnetLabel: string;
  // Camada de "conta" entre region e rede — existe de fato na hierarquia AWS
  // (Cloud > Region > Account > VPC). Opcional porque Azure/GCP usam outros
  // conceitos (Subscription/Project) já representados no nível "cloud" hoje.
  accountLabel?: string;
  accountTech?: string;
  accountTag?: string;
  // Tags do theme com ícone real para os deployment nodes (cloud/region/rede/subnet).
  // Quando o theme do provider não tem ícone equivalente, fica undefined — o
  // Structurizr renderiza o node sem ícone, só com o rótulo (comportamento atual).
  cloudTag?: string;
  regionTag?: string;
  networkTag?: string;
  subnetTag?: string;
  // Quando a subnet pública e a privada usam ícones diferentes (ex.: fallback
  // AWS, que tem um PNG "Public-subnet" e outro "Private-subnet" distintos),
  // estes dois têm prioridade sobre subnetTag (que assume o mesmo ícone pra ambas).
  publicSubnetTag?: string;
  privateSubnetTag?: string;
}

// O theme oficial AWS (static.structurizr.com, com CORS liberado) não tem ícone
// para "Cloud"/"Region"/"Subnet" (confirmado no theme.json: nenhuma das 891
// entradas bate com esses tags) — só a VPC tem. O theme mais novo (2025.07) tem
// esses ícones, mas só existe em playground.structurizr.com, que NÃO libera CORS
// e por isso falha no DSL Editor (confirmado por teste real do usuário).
// Fallback: tags próprias com ícone embutido em base64 (vem do pacote oficial
// AWS Architecture-Group-Icons_07312025, ver aws-icons.ts) — base64 não depende
// de CORS porque não é uma requisição de rede, é dado inline no próprio DSL.
const AWS_FALLBACK_TAG = {
  cloud: 'iacmp - AWS Cloud (fallback)',
  region: 'iacmp - AWS Region (fallback)',
  account: 'iacmp - AWS Account (fallback)',
  publicSubnet: 'iacmp - AWS Public Subnet (fallback)',
  privateSubnet: 'iacmp - AWS Private Subnet (fallback)',
};

const AWS_FALLBACK_ICONS: Array<{ tag: string; icon: string }> = [
  { tag: AWS_FALLBACK_TAG.cloud, icon: AWS_CLOUD_ICON_B64 },
  { tag: AWS_FALLBACK_TAG.region, icon: AWS_REGION_ICON_B64 },
  { tag: AWS_FALLBACK_TAG.account, icon: AWS_ACCOUNT_ICON_B64 },
  { tag: AWS_FALLBACK_TAG.publicSubnet, icon: AWS_PUBLIC_SUBNET_ICON_B64 },
  { tag: AWS_FALLBACK_TAG.privateSubnet, icon: AWS_PRIVATE_SUBNET_ICON_B64 },
];

const PROVIDER_DEPLOYMENT: Record<string, ProviderDeploymentMeta> = {
  aws: {
    cloud: 'AWS Cloud', cloudTech: 'Amazon Web Services', regionTech: 'AWS Region', viewTag: 'awsDeployment',
    networkLabel: 'VPC', networkTech: 'Virtual Private Cloud',
    publicSubnetLabel: 'Public Subnet A', privateSubnetLabel: 'Private Subnet A',
    accountLabel: 'AWS Account', accountTech: 'AWS Account',
    cloudTag: AWS_FALLBACK_TAG.cloud,
    regionTag: AWS_FALLBACK_TAG.region,
    accountTag: AWS_FALLBACK_TAG.account,
    networkTag: 'Amazon Web Services - VPC Virtual private cloud VPC',
    publicSubnetTag: AWS_FALLBACK_TAG.publicSubnet,
    privateSubnetTag: AWS_FALLBACK_TAG.privateSubnet,
  },
  azure: {
    cloud: 'Azure Cloud', cloudTech: 'Microsoft Azure', regionTech: 'Azure Region', viewTag: 'azureDeployment',
    networkLabel: 'VNet', networkTech: 'Virtual Network',
    publicSubnetLabel: 'Public Subnet', privateSubnetLabel: 'Private Subnet',
    cloudTag: 'Microsoft Azure - Subscriptions',
    regionTag: 'Microsoft Azure - Region Management',
    networkTag: 'Microsoft Azure - Virtual Networks',
    subnetTag: 'Microsoft Azure - Subnet',
  },
  gcp: {
    cloud: 'Google Cloud', cloudTech: 'Google Cloud Platform', regionTech: 'GCP Region', viewTag: 'gcpDeployment',
    networkLabel: 'VPC Network', networkTech: 'Virtual Private Cloud',
    publicSubnetLabel: 'Public Subnet', privateSubnetLabel: 'Private Subnet',
    // O theme oficial GCP não tem ícone para "Cloud"/"Region"/"Subnet" (confirmado
    // no theme.json: nenhuma das 107 entradas bate com esses tags) — só a VPC tem.
    networkTag: 'Google Cloud Platform - Virtual Private Cloud',
  },
  terraform: {
    cloud: 'AWS Cloud', cloudTech: 'Amazon Web Services', regionTech: 'AWS Region', viewTag: 'awsDeployment',
    networkLabel: 'VPC', networkTech: 'Virtual Private Cloud',
    publicSubnetLabel: 'Public Subnet A', privateSubnetLabel: 'Private Subnet A',
    accountLabel: 'AWS Account', accountTech: 'AWS Account',
    cloudTag: AWS_FALLBACK_TAG.cloud,
    regionTag: AWS_FALLBACK_TAG.region,
    accountTag: AWS_FALLBACK_TAG.account,
    networkTag: 'Amazon Web Services - VPC Virtual private cloud VPC',
    publicSubnetTag: AWS_FALLBACK_TAG.publicSubnet,
    privateSubnetTag: AWS_FALLBACK_TAG.privateSubnet,
  },
};

// Tipos de construct que ficam expostos na subnet pública (recebem tráfego
// de entrada da internet) — todo o resto compute/rede vai para a subnet privada.
const PUBLIC_FACING_TYPES = new Set([
  'Function.ApiGateway',
  'Network.LoadBalancer',
  'Network.CDN',
  'Network.WAF',
  'Network.Dns',
]);

// Tipos que representam a própria estrutura de rede (VPC, subnet, security
// group, vpc endpoint) — não fazem sentido como "instância hospedada dentro
// da subnet", pois são a rede em si. Ficam de fora da deployment view.
const NETWORK_INFRA_TYPES = new Set([
  'Network.VPC',
  'Network.Subnet',
  'Network.SecurityGroup',
]);

// Tipos gerenciados pelo provider que não rodam dentro de uma VPC/subnet
// (serviço regional/global da cloud, fora da malha de rede do cliente).
const ACCOUNT_LEVEL_TYPES = new Set([
  'Storage.Bucket',
  'Storage.Archive',
  'Storage.FileSystem',
  'Database.DynamoDB',
  'Database.DocumentDB',
  'Policy.IAM',
  'Secret.Vault',
  'Certificate.TLS',
  'Monitoring.Alarm',
  'Monitoring.Dashboard',
  'Logging.Stream',
  'Events.EventBridge',
  'Messaging.Queue',
  'Messaging.Topic',
]);

// Heurística para identificar recursos auxiliares (policy, encryption, alias,
// endpoint) que o provider gera como "Custom.Resource" — não são compute e
// não fazem sentido como instância dentro da rede.
function isAuxiliaryResource(node: DiagramNode): boolean {
  return node.constructType === 'Custom.Resource';
}

function ind(n: number): string {
  return '  '.repeat(n);
}

// Structurizr DSL delimita strings com aspas duplas e não documenta um escape
// portátil; o caminho seguro é remover as aspas (e quebras de linha) das labels
// para não derrubar o parser.
function escapeStructurizr(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

function containerBlock(node: DiagramNode, depth: number, tagMap: Record<string, string>): string {
  const tag = tagMap[node.constructType] ?? 'Resource';
  const desc = node.description || '';
  const lines = [
    `${ind(depth)}${node.id} = container "${escapeStructurizr(node.label)}" "${escapeStructurizr(desc)}" "${escapeStructurizr(node.technology)}" {`,
    `${ind(depth + 1)}tags "${escapeStructurizr(tag)}"`,
    `${ind(depth)}}`,
  ];
  return lines.join('\n');
}

// Abre um deploymentNode e, se houver tag com ícone no theme, adiciona a
// linha "tags" logo dentro — mesmo padrão usado em containerBlock().
function openDeploymentNode(name: string, tech: string, tag: string | undefined, depth: number): string[] {
  const lines = [`${ind(depth)}deploymentNode "${name}" "${tech}" {`];
  if (tag) lines.push(`${ind(depth + 1)}tags "${escapeStructurizr(tag)}"`);
  return lines;
}

function deploymentBlock(model: DiagramModel, depth: number): string {
  const meta = PROVIDER_DEPLOYMENT[model.provider] ?? PROVIDER_DEPLOYMENT['aws'];
  const allNodes = model.stacks.flatMap(s => s.nodes);
  if (allNodes.length === 0) return '';

  // Recursos que não são compute hospedado: a própria estrutura de rede e
  // recursos auxiliares (policy, encryption, alias, endpoint) não entram na
  // deployment view — não fazem sentido como "instância dentro da subnet".
  const deployableNodes = allNodes.filter(
    n => !NETWORK_INFRA_TYPES.has(n.constructType) && !isAuxiliaryResource(n),
  );

  const managedNodes = deployableNodes.filter(n => ACCOUNT_LEVEL_TYPES.has(n.constructType));
  const networkNodes = deployableNodes.filter(n => !ACCOUNT_LEVEL_TYPES.has(n.constructType));
  const publicNodes = networkNodes.filter(n => PUBLIC_FACING_TYPES.has(n.constructType));
  const privateNodes = networkNodes.filter(n => !PUBLIC_FACING_TYPES.has(n.constructType));

  if (publicNodes.length === 0 && privateNodes.length === 0 && managedNodes.length === 0) return '';

  const networkName = `${model.projectName}-${meta.networkLabel.toLowerCase().replace(/\s+/g, '-')}`;

  const lines: string[] = [];
  lines.push(`${ind(depth)}deploymentEnvironment "Production" {`);
  lines.push('');
  lines.push(...openDeploymentNode(meta.cloud, meta.cloudTech, meta.cloudTag, depth + 1));
  lines.push('');
  lines.push(...openDeploymentNode(`Region ${escapeStructurizr(model.region)}`, meta.regionTech, meta.regionTag, depth + 2));

  // Camada de conta (AWS: Cloud > Region > Account > VPC) — só abre quando o
  // provider declara accountLabel; Azure/GCP usam outro conceito (Subscription/
  // Project) já representado no nível "cloud" e ficam sem essa camada extra.
  let networkDepth = depth + 3;
  if (meta.accountLabel) {
    lines.push('');
    lines.push(...openDeploymentNode(meta.accountLabel, meta.accountTech ?? meta.accountLabel, meta.accountTag, depth + 3));
    networkDepth = depth + 4;
  }

  if (publicNodes.length > 0 || privateNodes.length > 0) {
    lines.push('');
    lines.push(...openDeploymentNode(`${meta.networkLabel} ${escapeStructurizr(networkName)}`, meta.networkTech, meta.networkTag, networkDepth));

    if (model.ha) {
      // Modo HA: replica a rede em duas AZs — mesmo par de subnets e os mesmos
      // containers (réplicas lógicas) em cada uma. O Structurizr representa
      // réplica repetindo "containerInstance X" em deploymentNodes diferentes.
      const azLabels = ['AZ-A', 'AZ-B'];
      const subnetSuffixes = ['A', 'B'];
      for (let i = 0; i < azLabels.length; i++) {
        const azDepth = networkDepth + 1;
        lines.push('');
        lines.push(`${ind(azDepth)}deploymentNode "${azLabels[i]}" "Availability Zone" {`);

        if (publicNodes.length > 0) {
          lines.push('');
          lines.push(...openDeploymentNode(`Public Subnet ${subnetSuffixes[i]}`, `10.0.${i * 20 + 1}.0/24`, meta.publicSubnetTag ?? meta.subnetTag, azDepth + 1));
          for (const node of publicNodes) {
            lines.push(`${ind(azDepth + 2)}containerInstance ${node.id}`);
          }
          lines.push(`${ind(azDepth + 1)}}`);
        }

        if (privateNodes.length > 0) {
          lines.push('');
          lines.push(...openDeploymentNode(`Private Subnet ${subnetSuffixes[i]}`, `10.0.${i * 20 + 11}.0/24`, meta.privateSubnetTag ?? meta.subnetTag, azDepth + 1));
          for (const node of privateNodes) {
            lines.push(`${ind(azDepth + 2)}containerInstance ${node.id}`);
          }
          lines.push(`${ind(azDepth + 1)}}`);
        }

        lines.push(`${ind(azDepth)}}`);
      }
    } else {
      if (publicNodes.length > 0) {
        lines.push('');
        lines.push(...openDeploymentNode(meta.publicSubnetLabel, '10.0.1.0/24', meta.publicSubnetTag ?? meta.subnetTag, networkDepth + 1));
        for (const node of publicNodes) {
          lines.push(`${ind(networkDepth + 2)}containerInstance ${node.id}`);
        }
        lines.push(`${ind(networkDepth + 1)}}`);
      }

      if (privateNodes.length > 0) {
        lines.push('');
        lines.push(...openDeploymentNode(meta.privateSubnetLabel, '10.0.11.0/24', meta.privateSubnetTag ?? meta.subnetTag, networkDepth + 1));
        for (const node of privateNodes) {
          lines.push(`${ind(networkDepth + 2)}containerInstance ${node.id}`);
        }
        lines.push(`${ind(networkDepth + 1)}}`);
      }
    }

    lines.push(`${ind(networkDepth)}}`);
  }

  if (managedNodes.length > 0) {
    lines.push('');
    lines.push(`${ind(networkDepth)}deploymentNode "Managed Services" "${meta.cloudTech} — serviços gerenciados fora da ${meta.networkLabel}" {`);
    for (const node of managedNodes) {
      lines.push(`${ind(networkDepth + 1)}containerInstance ${node.id}`);
    }
    lines.push(`${ind(networkDepth)}}`);
  }

  if (meta.accountLabel) {
    lines.push(`${ind(depth + 3)}}`);
  }
  lines.push(`${ind(depth + 2)}}`);
  lines.push(`${ind(depth + 1)}}`);
  lines.push(`${ind(depth)}}`);

  return lines.join('\n');
}

export function renderStructurizr(model: DiagramModel): string {
  const lines: string[] = [];
  const themeUrl = PROVIDER_THEME[model.provider] ?? PROVIDER_THEME['aws'];
  const tagMap = PROVIDER_TAGS[model.provider] ?? AWS_TYPE_TAG;

  lines.push(`workspace "${escapeStructurizr(model.projectName)}" {`);
  lines.push('');
  lines.push(`${ind(1)}model {`);
  lines.push(`${ind(2)}${sanitize(model.projectName)} = softwareSystem "${escapeStructurizr(model.projectName)}" "Provider: ${escapeStructurizr(model.provider)}, Region: ${escapeStructurizr(model.region)}" {`);

  for (const stack of model.stacks) {
    lines.push('');
    lines.push(`${ind(3)}group "${escapeStructurizr(stack.name)}" {`);
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
        lines.push(`${ind(2)}${rel.sourceId} -> ${rel.targetId} "${escapeStructurizr(rel.label)}"`);
      }
    }
  }

  const deployment = deploymentBlock(model, 2);
  if (deployment) {
    lines.push('');
    lines.push(deployment);
  }

  lines.push(`${ind(1)}}`);
  lines.push('');
  lines.push(`${ind(1)}views {`);

  const sysId = sanitize(model.projectName);
  for (const stack of model.stacks) {
    const viewId = sanitize(`${stack.name}View`);
    lines.push('');
    lines.push(`${ind(2)}container ${sysId} "${viewId}" "${escapeStructurizr(stack.name)}" {`);
    lines.push(`${ind(3)}include *`);
    lines.push(`${ind(3)}autoLayout`);
    lines.push(`${ind(2)}}`);
  }

  if (deployment) {
    const deployMeta = PROVIDER_DEPLOYMENT[model.provider] ?? PROVIDER_DEPLOYMENT['aws'];
    lines.push('');
    lines.push(`${ind(2)}deployment ${sysId} "Production" "${deployMeta.viewTag}" {`);
    lines.push(`${ind(3)}include *`);
    lines.push(`${ind(3)}autoLayout tb 300 100`);
    lines.push(`${ind(2)}}`);
  }

  lines.push('');
  lines.push(`${ind(2)}theme "${themeUrl}"`);
  lines.push('');
  lines.push(`${ind(2)}styles {`);
  lines.push(`${ind(3)}relationship "Inferred" {`);
  lines.push(`${ind(4)}dashed true`);
  lines.push(`${ind(4)}colour #999999`);
  lines.push(`${ind(3)}}`);
  if (model.provider === 'aws' || model.provider === 'terraform') {
    for (const { tag, icon } of AWS_FALLBACK_ICONS) {
      lines.push(`${ind(3)}element "${escapeStructurizr(tag)}" {`);
      lines.push(`${ind(4)}icon "${icon}"`);
      lines.push(`${ind(3)}}`);
    }
  }
  lines.push(`${ind(2)}}`);
  lines.push(`${ind(1)}}`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}
