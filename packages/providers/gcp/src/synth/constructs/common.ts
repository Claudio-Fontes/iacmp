export interface TFOutput {
  resources: Record<string, Record<string, unknown>>;
  outputs: Record<string, { value: string }>;
  needsZoneVar: boolean;
}

export function toTfId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
}

/**
 * Normaliza um id de construct para um `name` válido em recursos GCP cujo
 * campo `name` é restrito por RFC1035: minúsculas, começa com letra, só
 * `[a-z0-9-]`, termina em alfanumérico, máx 63 chars.
 * Use apenas nos recursos que a API do provider `google` de fato restringe
 * (docs/roadmap-fase2.md §2.2.2) — não em todo lugar.
 */
export function gcpName(id: string): string {
  let name = id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!/^[a-z]/.test(name)) name = `a-${name}`;
  name = name.slice(0, 63).replace(/-+$/, '');
  return name || 'a';
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
