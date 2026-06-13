import { Stack, BaseConstruct } from '@iacmp/core';
import { DiagramModel, DiagramStack, DiagramNode, DiagramRelationship } from './model';

// Emoji e tecnologia por construct type
const TYPE_META: Record<string, { emoji: string; technology: string }> = {
  'Compute.Instance': { emoji: '⚙️',  technology: 'Virtual Machine' },
  'Storage.Bucket':   { emoji: '🗂️',  technology: 'Object Storage'  },
  'Network.VPC':      { emoji: '🌐',  technology: 'Virtual Network' },
  'Database.SQL':     { emoji: '🗄️',  technology: 'Relational DB'   },
  'Function.Lambda':  { emoji: '⚡',  technology: 'Serverless'       },
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

export function buildModel(
  projectName: string,
  provider: string,
  region: string,
  stacks: Array<{ name: string; stack: Stack }>,
): DiagramModel {
  return {
    projectName,
    provider,
    region,
    stacks: stacks.map(({ name, stack }) => buildStackDiagram(name, stack)),
  };
}
