import { Stack, BaseConstruct } from '@iacmp/core';
import { DiagramModel, DiagramStack, DiagramNode, DiagramRelationship } from './model';

const TYPE_META: Record<string, { emoji: string; technology: string }> = {
  'Compute.Instance':       { emoji: '⚙️',  technology: 'Virtual Machine'    },
  'Storage.Bucket':         { emoji: '🗂️',  technology: 'Object Storage'     },
  'Network.VPC':            { emoji: '🌐',  technology: 'Virtual Network'    },
  'Network.Subnet':         { emoji: '🔀',  technology: 'Subnet'             },
  'Network.SecurityGroup':  { emoji: '🛡️',  technology: 'Security Group'     },
  'Network.WAF':            { emoji: '🔒',  technology: 'WAF'                },
  'Database.SQL':           { emoji: '🗄️',  technology: 'Relational DB'      },
  'Database.DocumentDB':    { emoji: '📄',  technology: 'Document DB'        },
  'Cache.Redis':            { emoji: '⚡',  technology: 'Cache'              },
  'Function.Lambda':        { emoji: '⚡',  technology: 'Serverless'         },
  'Policy.IAM':             { emoji: '🔑',  technology: 'IAM Policy'         },
  'Events.EventBridge':     { emoji: '📡',  technology: 'Event Bus'          },
  'Workflow.StepFunctions': { emoji: '🔄',  technology: 'Step Functions'     },
  'Messaging.Queue':        { emoji: '📨',  technology: 'Queue (SQS)'        },
  'Messaging.Topic':        { emoji: '📢',  technology: 'Topic (SNS)'        },
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
    { pattern: /TABLE_NAME|DYNAMO|DYNAMODB/i,      targetType: 'Database.SQL',           label: 'reads table'    },
    { pattern: /DB_HOST|DB_URL|DATABASE_URL/i,     targetType: 'Database.SQL',           label: 'connects db'    },
    { pattern: /BUCKET_NAME|S3_BUCKET/i,           targetType: 'Storage.Bucket',         label: 'reads bucket'   },
    { pattern: /VPC_ID|VPC_CIDR/i,                 targetType: 'Network.VPC',            label: 'uses vpc'       },
    { pattern: /REDIS_URL|REDIS_HOST|CACHE_URL/i,  targetType: 'Cache.Redis',            label: 'uses cache'     },
    { pattern: /DOCDB_URL|MONGO_URL/i,             targetType: 'Database.DocumentDB',    label: 'reads docdb'    },
    { pattern: /QUEUE_URL|SQS_URL/i,               targetType: 'Messaging.Queue',        label: 'sends to queue' },
    { pattern: /TOPIC_ARN|SNS_ARN/i,               targetType: 'Messaging.Topic',        label: 'publishes to'   },
  ];

  for (const srcStack of builtStacks) {
    for (const srcNode of srcStack.nodes) {
      if (srcNode.constructType !== 'Function.Lambda') continue;
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

  return relationships;
}

export function buildModel(
  projectName: string,
  provider: string,
  region: string,
  stacks: Array<{ name: string; stack: Stack }>,
): DiagramModel {
  const builtStacks = stacks.map(({ name, stack }) => buildStackDiagram(name, stack));
  const crossRelationships = inferCrossStackRelationships(builtStacks);

  // Adiciona relacionamentos cross-stack à primeira stack que tem o nó fonte
  for (const rel of crossRelationships) {
    for (const s of builtStacks) {
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
    stacks: builtStacks,
  };
}
