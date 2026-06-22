export interface DiagramNode {
  id: string;
  label: string;
  constructType: string;
  technology: string;
  description: string;
  props: Record<string, unknown>;
}

export interface DiagramRelationship {
  sourceId: string;
  targetId: string;
  label: string;
  inferred: boolean;
}

export interface DiagramStack {
  name: string;
  nodes: DiagramNode[];
  relationships: DiagramRelationship[];
}

export interface DiagramModel {
  projectName: string;
  provider: string;
  region: string;
  stacks: DiagramStack[];
  ha: boolean;
}
