export interface TFOutput {
  resources: Record<string, Record<string, unknown>>;
  outputs: Record<string, { value: string }>;
  needsZoneVar: boolean;
}

export function toTfId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

export function addResource(
  resources: Record<string, Record<string, unknown>>,
  tfType: string,
  tfId: string,
  props: Record<string, unknown>,
): void {
  if (!resources[tfType]) resources[tfType] = {};
  resources[tfType][tfId] = props;
}

export const RUNTIME_MAP: Record<string, string> = {
  'nodejs20': 'nodejs20',
  'nodejs18': 'nodejs18',
  'python3.12': 'python312',
  'python3.11': 'python311',
  'java21': 'java21',
  'go1.x': 'go121',
  'dotnet8': 'dotnet8',
};
