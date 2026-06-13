import { DiagramModel, DiagramNode } from './model';

const TYPE_EMOJI: Record<string, string> = {
  'Compute.Instance': '⚙️',
  'Storage.Bucket':   '🗂️',
  'Network.VPC':      '🌐',
  'Database.SQL':     '🗄️',
  'Function.Lambda':  '⚡',
};

function nodeLabel(node: DiagramNode): string {
  const emoji = TYPE_EMOJI[node.constructType] ?? '□';
  const lines = [
    `${emoji} ${node.label}`,
    node.constructType,
  ];
  if (node.description) lines.push(node.description);
  // Mermaid usa \n dentro de aspas para múltiplas linhas em node labels
  return `["${lines.join('<br/>')}"]`;
}

export function renderMermaid(model: DiagramModel): string {
  const sections: string[] = [];

  sections.push(`# Diagramas de Arquitetura — ${model.projectName}`);
  sections.push('');
  sections.push(`**Provider:** ${model.provider} · **Region:** ${model.region}`);
  sections.push('');
  sections.push('---');

  for (const stack of model.stacks) {
    sections.push('');
    sections.push(`## Stack: ${stack.name}`);
    sections.push('');
    sections.push('```mermaid');
    sections.push('graph TD');

    // Nodes
    for (const node of stack.nodes) {
      sections.push(`  ${node.id}${nodeLabel(node)}`);
    }

    // Relationships
    if (stack.relationships.length > 0) {
      sections.push('');
      for (const rel of stack.relationships) {
        if (rel.inferred) {
          sections.push(`  ${rel.sourceId} -.->|inferred| ${rel.targetId}`);
        } else {
          sections.push(`  ${rel.sourceId} -->|${rel.label}| ${rel.targetId}`);
        }
      }
    }

    sections.push('```');
    sections.push('');

    // Legenda de recursos
    sections.push('**Recursos:**');
    sections.push('');
    for (const node of stack.nodes) {
      const emoji = TYPE_EMOJI[node.constructType] ?? '□';
      const detail = node.description ? ` — ${node.description}` : '';
      sections.push(`- ${emoji} **${node.label}** \`${node.constructType}\`${detail}`);
    }

    if (stack.relationships.some(r => r.inferred)) {
      sections.push('');
      sections.push('> Setas tracejadas indicam relações inferidas a partir da topologia da stack, não declaradas explicitamente no código.');
    }

    sections.push('');
    sections.push('---');
  }

  return sections.join('\n') + '\n';
}
