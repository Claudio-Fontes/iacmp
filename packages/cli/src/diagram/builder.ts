import { Stack, BaseConstruct } from '@iacmp/core';
import { DiagramModel, DiagramStack, DiagramNode, DiagramRelationship } from './model';

const TYPE_META: Record<string, { emoji: string; technology: string }> = {
  'Compute.Instance':         { emoji: '⚙️',  technology: 'Virtual Machine'        },
  'Compute.AutoScaling':      { emoji: '⚙️',  technology: 'Auto Scaling Group'     },
  'Compute.Container':        { emoji: '📦',  technology: 'Container (ECS/Fargate)'},
  'Compute.Kubernetes':       { emoji: '☸️',  technology: 'Kubernetes (EKS)'       },
  'Storage.Bucket':           { emoji: '🗂️',  technology: 'Object Storage'         },
  'Storage.FileSystem':       { emoji: '🗄️',  technology: 'File System (EFS)'      },
  'Storage.Archive':          { emoji: '🗃️',  technology: 'Archive (Glacier)'      },
  'Network.VPC':              { emoji: '🌐',  technology: 'Virtual Network'        },
  'Network.Subnet':           { emoji: '🔀',  technology: 'Subnet'                 },
  'Network.SecurityGroup':    { emoji: '🛡️',  technology: 'Security Group'         },
  'Network.WAF':              { emoji: '🔒',  technology: 'WAF'                    },
  'Network.LoadBalancer':     { emoji: '⚖️',  technology: 'Load Balancer'          },
  'Network.CDN':              { emoji: '🌍',  technology: 'CDN (CloudFront)'       },
  'Network.Dns':              { emoji: '🌐',  technology: 'DNS (Route53)'          },
  'Database.SQL':             { emoji: '🗄️',  technology: 'Relational DB'          },
  'Database.DocumentDB':      { emoji: '📄',  technology: 'Document DB'            },
  'Database.DynamoDB':        { emoji: '⚡',  technology: 'DynamoDB'               },
  'Cache.Redis':              { emoji: '⚡',  technology: 'Redis Cache'            },
  'Cache.Memcached':          { emoji: '⚡',  technology: 'Memcached Cache'        },
  'Function.Lambda':          { emoji: '⚡',  technology: 'Serverless'             },
  'Function.ApiGateway':      { emoji: '🔌',  technology: 'API Gateway'            },
  'Policy.IAM':               { emoji: '🔑',  technology: 'IAM Policy'             },
  'Events.EventBridge':       { emoji: '📡',  technology: 'Event Bus'              },
  'Workflow.StepFunctions':   { emoji: '🔄',  technology: 'Step Functions'         },
  'Messaging.Queue':          { emoji: '📨',  technology: 'Queue (SQS)'            },
  'Messaging.Topic':          { emoji: '📢',  technology: 'Topic (SNS)'            },
  'Secret.Vault':             { emoji: '🔐',  technology: 'Secrets Manager'        },
  'Certificate.TLS':          { emoji: '🔏',  technology: 'TLS Certificate (ACM)'  },
  'Monitoring.Alarm':         { emoji: '🚨',  technology: 'CloudWatch Alarm'       },
  'Monitoring.Dashboard':     { emoji: '📊',  technology: 'CloudWatch Dashboard'   },
  'Logging.Stream':           { emoji: '📋',  technology: 'CloudWatch Logs'        },
};

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_');
}

function describeProps(c: BaseConstruct): string {
  const p = c.props;
  const parts: string[] = [];

  if (c.type === 'Compute.Instance') {
    if (p.instanceType) parts.push(`size: ${p.instanceType}`);
    if (p.image) parts.push(`image: ${p.image}`);
  }
  if (c.type === 'Storage.Bucket') {
    parts.push(p.versioning ? 'versioning: on' : 'versioning: off');
    parts.push(p.publicAccess ? 'public' : 'private');
  }
  if (c.type === 'Network.VPC') {
    if (p.cidr) parts.push(`cidr: ${p.cidr}`);
    if (p.maxAzs) parts.push(`maxAzs: ${p.maxAzs}`);
  }
  if (c.type === 'Database.SQL') {
    if (p.engine) parts.push(`engine: ${p.engine}`);
    if (p.multiAz) parts.push('Multi-AZ');
    if (p.instanceType) parts.push(`size: ${p.instanceType}`);
  }
  if (c.type === 'Function.Lambda') {
    if (p.runtime) parts.push(`runtime: ${p.runtime}`);
    if (p.memory) parts.push(`memory: ${p.memory}MB`);
    if (p.handler) parts.push(`handler: ${p.handler}`);
  }
  if (c.type === 'Network.SecurityGroup') {
    const ingress = (p.ingressRules as Array<Record<string, unknown>>) ?? [];
    if (ingress.length > 0) parts.push(`${ingress.length} ingress rules`);
  }
  if (c.type === 'Network.WAF') {
    const rules = (p.rules as Array<unknown>) ?? [];
    parts.push(`${rules.length} rules`);
    if (p.scope) parts.push(`scope: ${p.scope}`);
  }
  if (c.type === 'Cache.Redis') {
    if (p.nodeType) parts.push(`size: ${p.nodeType}`);
    if (p.numCacheNodes) parts.push(`nodes: ${p.numCacheNodes}`);
  }
  if (c.type === 'Database.DocumentDB') {
    if (p.instances) parts.push(`instances: ${p.instances}`);
  }
  if (c.type === 'Policy.IAM') {
    if (p.attachTo) parts.push(`attachTo: ${p.attachTo}`);
    if (p.attachType) parts.push(`type: ${p.attachType}`);
  }
  if (c.type === 'Events.EventBridge') {
    const rules = (p.rules as Array<unknown>) ?? [];
    if (rules.length > 0) parts.push(`${rules.length} rules`);
  }
  if (c.type === 'Workflow.StepFunctions') {
    const steps = (p.steps as Array<unknown>) ?? [];
    parts.push(`${steps.length} steps`);
    if (p.type) parts.push(p.type as string);
  }
  if (c.type === 'Messaging.Queue') {
    if (p.fifo) parts.push('FIFO');
    if (p.encrypted) parts.push('encrypted');
    if (p.dlqArn) parts.push('DLQ configured');
  }
  if (c.type === 'Messaging.Topic') {
    if (p.fifo) parts.push('FIFO');
    const subs = (p.subscriptions as Array<unknown>) ?? [];
    if (subs.length > 0) parts.push(`${subs.length} subscriptions`);
  }
  if (c.type === 'Compute.AutoScaling') {
    if (p.minCapacity !== undefined) parts.push(`min: ${p.minCapacity}`);
    if (p.maxCapacity !== undefined) parts.push(`max: ${p.maxCapacity}`);
    if (p.targetCpuUtilization) parts.push(`cpu: ${p.targetCpuUtilization}%`);
  }
  if (c.type === 'Compute.Container') {
    if (p.image) parts.push(`image: ${p.image}`);
    if (p.cpu) parts.push(`cpu: ${p.cpu}`);
    if (p.memory) parts.push(`mem: ${p.memory}MB`);
  }
  if (c.type === 'Compute.Kubernetes') {
    if (p.version) parts.push(`k8s: ${p.version}`);
    if (p.desiredNodes) parts.push(`nodes: ${p.desiredNodes}`);
    if (p.nodeInstanceType) parts.push(`size: ${p.nodeInstanceType}`);
  }
  if (c.type === 'Storage.FileSystem') {
    if (p.performanceMode) parts.push(`perf: ${p.performanceMode}`);
    if (p.encrypted) parts.push('encrypted');
    const aps = (p.accessPoints as Array<unknown>) ?? [];
    if (aps.length > 0) parts.push(`${aps.length} access points`);
  }
  if (c.type === 'Storage.Archive') {
    if (p.retentionDays) parts.push(`retention: ${p.retentionDays}d`);
    if (p.lockEnabled) parts.push('lock enabled');
  }
  if (c.type === 'Network.LoadBalancer') {
    if (p.type) parts.push(`type: ${p.type}`);
    if (p.scheme) parts.push(p.scheme as string);
    const tgs = (p.targetGroups as Array<unknown>) ?? [];
    if (tgs.length > 0) parts.push(`${tgs.length} target groups`);
  }
  if (c.type === 'Network.CDN') {
    const origins = (p.origins as Array<unknown>) ?? [];
    if (origins.length > 0) parts.push(`${origins.length} origins`);
    if (p.priceClass) parts.push(p.priceClass as string);
  }
  if (c.type === 'Network.Dns') {
    if (p.zoneName) parts.push(`zone: ${p.zoneName}`);
    const records = (p.records as Array<unknown>) ?? [];
    if (records.length > 0) parts.push(`${records.length} records`);
  }
  if (c.type === 'Database.DynamoDB') {
    if (p.partitionKey) parts.push(`pk: ${p.partitionKey}`);
    if (p.billingMode) parts.push(p.billingMode as string);
    if (p.streamEnabled) parts.push('streams on');
  }
  if (c.type === 'Cache.Memcached') {
    if (p.nodeType) parts.push(`size: ${p.nodeType}`);
    if (p.numCacheNodes) parts.push(`nodes: ${p.numCacheNodes}`);
  }
  if (c.type === 'Function.ApiGateway') {
    if (p.type) parts.push(`type: ${p.type}`);
    if (p.stageName) parts.push(`stage: ${p.stageName}`);
    const routes = (p.routes as Array<unknown>) ?? [];
    if (routes.length > 0) parts.push(`${routes.length} routes`);
  }
  if (c.type === 'Secret.Vault') {
    if (p.rotationDays) parts.push(`rotation: ${p.rotationDays}d`);
    if (p.kmsKeyId) parts.push('KMS encrypted');
  }
  if (c.type === 'Certificate.TLS') {
    if (p.domainName) parts.push(`domain: ${p.domainName}`);
    if (p.validationMethod) parts.push(p.validationMethod as string);
  }
  if (c.type === 'Monitoring.Alarm') {
    if (p.metricName) parts.push(`metric: ${p.metricName}`);
    if (p.threshold !== undefined) parts.push(`threshold: ${p.threshold}`);
  }
  if (c.type === 'Monitoring.Dashboard') {
    const widgets = (p.widgets as Array<unknown>) ?? [];
    parts.push(`${widgets.length} widgets`);
  }
  if (c.type === 'Logging.Stream') {
    if (p.retentionDays) parts.push(`retention: ${p.retentionDays}d`);
    const filters = (p.subscriptionFilters as Array<unknown>) ?? [];
    if (filters.length > 0) parts.push(`${filters.length} filters`);
  }

  return parts.join(', ');
}

function buildStackDiagram(name: string, stack: Stack): DiagramStack {
  const nodes: DiagramNode[] = stack.constructs.map(c => {
    const meta = TYPE_META[c.type] ?? { emoji: '□', technology: c.type };
    return {
      id: safeId(`${name}_${c.id}`),
      label: c.id,
      constructType: c.type,
      technology: meta.technology,
      description: describeProps(c),
      props: c.props,
    };
  });

  // Inferência de relacionamentos
  const relationships: DiagramRelationship[] = [];
  const vpcs = nodes.filter(n => n.constructType === 'Network.VPC');
  const lambdas = nodes.filter(n => n.constructType === 'Function.Lambda');
  const databases = nodes.filter(n => n.constructType === 'Database.SQL');

  // VPC única → seta tracejada para todos os outros
  if (vpcs.length === 1) {
    const vpcId = vpcs[0].id;
    for (const node of nodes) {
      if (node.id === vpcId) continue;
      relationships.push({ sourceId: vpcId, targetId: node.id, label: 'inferred', inferred: true });
    }
  }

  // Lambda → Database: se há apenas uma de cada, infere leitura
  if (lambdas.length > 0 && databases.length > 0) {
    for (const lambda of lambdas) {
      for (const db of databases) {
        relationships.push({ sourceId: lambda.id, targetId: db.id, label: 'reads', inferred: true });
      }
    }
  }

  // ApiGateway → Lambda via routes[].lambdaId (mesma stack)
  const apiGateways = stack.constructs.filter(c => c.type === 'Function.ApiGateway');
  for (const gw of apiGateways) {
    const routes = (gw.props?.routes as Array<{ lambdaId?: string }>) ?? [];
    const gwNode = nodes.find(n => n.label === gw.id);
    if (!gwNode) continue;
    for (const route of routes) {
      if (!route.lambdaId) continue;
      const lambdaNode = nodes.find(n => n.label === route.lambdaId);
      if (lambdaNode) {
        relationships.push({ sourceId: gwNode.id, targetId: lambdaNode.id, label: 'invokes', inferred: false });
      }
    }
  }

  return { name, nodes, relationships };
}

// BUG-05 fix: infere relacionamentos cross-stack via environment variables
// ex: Lambda com TABLE_NAME aponta para Database em outra stack
function inferCrossStackRelationships(
  builtStacks: DiagramStack[],
): DiagramRelationship[] {
  const relationships: DiagramRelationship[] = [];

  // Índice: id do nó → nó
  const nodeById: Record<string, DiagramNode> = {};
  for (const s of builtStacks) {
    for (const n of s.nodes) nodeById[n.id] = n;
  }

  // Heurísticas de env keys para inferir dependência
  const ENV_HINTS: Array<{ pattern: RegExp; targetType: string; label: string }> = [
    { pattern: /TABLE_NAME|DYNAMO|DYNAMODB/i,         targetType: 'Database.DynamoDB',      label: 'reads table'       },
    { pattern: /DB_HOST|DB_URL|DATABASE_URL/i,        targetType: 'Database.SQL',           label: 'connects db'       },
    { pattern: /BUCKET_NAME|S3_BUCKET/i,              targetType: 'Storage.Bucket',         label: 'reads bucket'      },
    { pattern: /VPC_ID|VPC_CIDR/i,                   targetType: 'Network.VPC',            label: 'uses vpc'          },
    { pattern: /REDIS_URL|REDIS_HOST|CACHE_URL/i,    targetType: 'Cache.Redis',            label: 'uses cache'        },
    { pattern: /MEMCACHED_URL|MEMCACHE_HOST/i,       targetType: 'Cache.Memcached',        label: 'uses memcached'    },
    { pattern: /DOCDB_URL|MONGO_URL/i,               targetType: 'Database.DocumentDB',    label: 'reads docdb'       },
    { pattern: /QUEUE_URL|SQS_URL/i,                 targetType: 'Messaging.Queue',        label: 'sends to queue'    },
    { pattern: /TOPIC_ARN|SNS_ARN/i,                 targetType: 'Messaging.Topic',        label: 'publishes to'      },
    { pattern: /API_URL|API_ENDPOINT|APIGW/i,        targetType: 'Function.ApiGateway',    label: 'calls api'         },
    { pattern: /SECRET_ARN|SECRETS_MANAGER/i,        targetType: 'Secret.Vault',           label: 'reads secret'      },
    { pattern: /EFS_ID|FILESYSTEM_ID/i,              targetType: 'Storage.FileSystem',     label: 'mounts filesystem' },
    { pattern: /LOG_GROUP|LOG_STREAM/i,              targetType: 'Logging.Stream',         label: 'writes logs'       },
  ];

  const ENV_CAPABLE_TYPES = new Set([
    'Function.Lambda', 'Compute.Container', 'Compute.Instance', 'Compute.AutoScaling',
  ]);

  for (const srcStack of builtStacks) {
    for (const srcNode of srcStack.nodes) {
      if (!ENV_CAPABLE_TYPES.has(srcNode.constructType)) continue;
      const env = srcNode.props?.environment as Record<string, string> | undefined;
      if (!env || Object.keys(env).length === 0) continue;

      for (const hint of ENV_HINTS) {
        const matched = Object.keys(env).some(k => hint.pattern.test(k));
        if (!matched) continue;

        // Procura nó do tipo alvo em outras stacks
        for (const tgtStack of builtStacks) {
          if (tgtStack.name === srcStack.name) continue;
          for (const tgtNode of tgtStack.nodes) {
            if (tgtNode.constructType !== hint.targetType) continue;
            relationships.push({
              sourceId: srcNode.id,
              targetId: tgtNode.id,
              label: hint.label,
              inferred: true,
            });
          }
        }
      }
    }
  }

  // ApiGateway cross-stack → Lambda via routes[].lambdaId
  for (const srcStack of builtStacks) {
    for (const srcNode of srcStack.nodes) {
      if (srcNode.constructType !== 'Function.ApiGateway') continue;
      const routes = (srcNode.props?.routes as Array<{ lambdaId?: string }>) ?? [];
      for (const route of routes) {
        if (!route.lambdaId) continue;
        // Procura lambda com esse label em qualquer stack (exceto a própria, já tratada)
        for (const tgtStack of builtStacks) {
          if (tgtStack.name === srcStack.name) continue;
          const tgtNode = tgtStack.nodes.find(n => n.label === route.lambdaId);
          if (tgtNode) {
            relationships.push({ sourceId: srcNode.id, targetId: tgtNode.id, label: 'invokes', inferred: false });
          }
        }
      }
    }
  }

  return relationships;
}

export function buildModel(
  projectName: string,
  provider: string,
  region: string,
  stacks: Array<{ name: string; stack: Stack }>,
): DiagramModel {
  const builtStacks = stacks.map(({ name, stack }) => buildStackDiagram(name, stack));

  // Deduplica nós com mesmo id global (ex: dois arquivos produzem o mesmo construct)
  const seenNodeIds = new Set<string>();
  for (const s of builtStacks) {
    s.nodes = s.nodes.filter(n => {
      if (seenNodeIds.has(n.id)) return false;
      seenNodeIds.add(n.id);
      return true;
    });
    // Remove relacionamentos que referenciam nós removidos
    s.relationships = s.relationships.filter(
      r => seenNodeIds.has(r.sourceId) && seenNodeIds.has(r.targetId),
    );
  }

  // Remove stacks que ficaram sem nós após deduplicação
  const nonEmptyStacks = builtStacks.filter(s => s.nodes.length > 0);
  // Mas mantemos referências completas para inferência cross-stack
  const crossRelationships = inferCrossStackRelationships(builtStacks);

  // Adiciona relacionamentos cross-stack à primeira stack (não vazia) que tem o nó fonte
  for (const rel of crossRelationships) {
    for (const s of nonEmptyStacks) {
      if (s.nodes.some(n => n.id === rel.sourceId)) {
        s.relationships.push(rel);
        break;
      }
    }
  }

  return {
    projectName,
    provider,
    region,
    stacks: nonEmptyStacks,
  };
}
