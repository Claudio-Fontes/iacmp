import { DiagramModel, DiagramNode } from './model';

const TYPE_TAG: Record<string, string> = {
  'Compute.Instance': 'Compute',
  'Storage.Bucket':   'Storage',
  'Network.VPC':      'Network',
  'Database.SQL':     'Database',
  'Function.Lambda':  'Function',
};

function ind(n: number): string {
  return '  '.repeat(n);
}

function containerBlock(node: DiagramNode, depth: number): string {
  const tag = TYPE_TAG[node.constructType] ?? 'Resource';
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

  lines.push(`workspace "${model.projectName}" {`);
  lines.push('');
  lines.push(`${ind(1)}model {`);
  lines.push(`${ind(2)}${sanitize(model.projectName)} = softwareSystem "${model.projectName}" "Provider: ${model.provider}, Region: ${model.region}" {`);

  for (const stack of model.stacks) {
    lines.push('');
    lines.push(`${ind(3)}group "${stack.name}" {`);
    for (const node of stack.nodes) {
      lines.push(containerBlock(node, 4));
    }
    lines.push(`${ind(3)}}`);
  }

  lines.push(`${ind(2)}}`);

  // Relações inferidas ficam fora do softwareSystem
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
  lines.push(`${ind(2)}styles {`);
  lines.push(`${ind(3)}element "Compute" {`);
  lines.push(`${ind(4)}background #1168bd`);
  lines.push(`${ind(4)}color #ffffff`);
  lines.push(`${ind(4)}shape RoundedBox`);
  lines.push(`${ind(3)}}`);
  lines.push(`${ind(3)}element "Storage" {`);
  lines.push(`${ind(4)}background #f5a623`);
  lines.push(`${ind(4)}color #ffffff`);
  lines.push(`${ind(4)}shape Folder`);
  lines.push(`${ind(3)}}`);
  lines.push(`${ind(3)}element "Network" {`);
  lines.push(`${ind(4)}background #6ab04c`);
  lines.push(`${ind(4)}color #ffffff`);
  lines.push(`${ind(4)}shape Hexagon`);
  lines.push(`${ind(3)}}`);
  lines.push(`${ind(3)}element "Database" {`);
  lines.push(`${ind(4)}background #eb4d4b`);
  lines.push(`${ind(4)}color #ffffff`);
  lines.push(`${ind(4)}shape Cylinder`);
  lines.push(`${ind(3)}}`);
  lines.push(`${ind(3)}element "Function" {`);
  lines.push(`${ind(4)}background #9b59b6`);
  lines.push(`${ind(4)}color #ffffff`);
  lines.push(`${ind(4)}shape Component`);
  lines.push(`${ind(3)}}`);
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
