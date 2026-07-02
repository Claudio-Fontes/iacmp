export interface ResourceRef {
  readonly kind: 'iacmp:resource-ref';
  readonly targetLogicalId: string;
  readonly attribute: string;
}

export interface ImportRef {
  readonly kind: 'iacmp:import-ref';
  readonly exportName: string;
}

export interface SubRef {
  readonly kind: 'iacmp:sub-ref';
  readonly template: string;
  readonly vars: Record<string, ResourceRef | ImportRef | string>;
}

export type GraphValue = ResourceRef | ImportRef | SubRef;

export interface ResourceNode {
  readonly logicalId: string;
  readonly awsType: string;
  readonly properties: Record<string, unknown>;
  readonly dependsOn: string[];
  readonly deletionPolicy?: string;
}

export interface StackExport {
  readonly key: string;
  readonly name: string;
  readonly value: unknown;
}

export interface StackGraph {
  readonly stackName: string;
  readonly nodes: ResourceNode[];
  readonly exports: StackExport[];
}

export function resourceRef(targetLogicalId: string, attribute: string): ResourceRef {
  return { kind: 'iacmp:resource-ref', targetLogicalId, attribute };
}

export function importRef(exportName: string): ImportRef {
  return { kind: 'iacmp:import-ref', exportName };
}

export function subRef(
  template: string,
  vars: Record<string, ResourceRef | ImportRef | string> = {},
): SubRef {
  return { kind: 'iacmp:sub-ref', template, vars };
}

export function isResourceRef(v: unknown): v is ResourceRef {
  return typeof v === 'object' && v !== null && (v as ResourceRef).kind === 'iacmp:resource-ref';
}

export function isImportRef(v: unknown): v is ImportRef {
  return typeof v === 'object' && v !== null && (v as ImportRef).kind === 'iacmp:import-ref';
}

export function isSubRef(v: unknown): v is SubRef {
  return typeof v === 'object' && v !== null && (v as SubRef).kind === 'iacmp:sub-ref';
}

export function isGraphValue(v: unknown): v is GraphValue {
  return isResourceRef(v) || isImportRef(v) || isSubRef(v);
}
