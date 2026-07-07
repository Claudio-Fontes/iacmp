export const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 'e2-small',
  medium: 'e2-medium',
  large: 'e2-standard-4',
};

export const GCP_IMAGE_MAP: Record<string, string> = {
  'ubuntu': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
  'ubuntu-22.04': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts',
  'ubuntu-20.04': 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2004-lts',
  'windows-2022': 'projects/windows-cloud/global/images/family/windows-2022',
  'windows-2019': 'projects/windows-cloud/global/images/family/windows-2019',
  'windows-2016': 'projects/windows-cloud/global/images/family/windows-2016',
};

export const CACHE_TIER_MAP: Record<string, string> = {
  small: 'BASIC',
  medium: 'STANDARD_HA',
  large: 'STANDARD_HA',
};

export const CACHE_CAPACITY_MAP: Record<string, number> = {
  small: 1,
  medium: 5,
  large: 16,
};

export const K8S_MACHINE_MAP: Record<string, string> = {
  small: 'e2-medium',
  medium: 'e2-standard-4',
  large: 'n2-standard-8',
};

export function resolveGcpImage(image: string | undefined): string {
  if (!image) return 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts';
  return GCP_IMAGE_MAP[image] ?? `global/images/${image}`;
}

/**
 * Extrai a região a partir de uma zona ou região GCP.
 * Ex: 'us-central1-a' → 'us-central1', 'us-central1' → 'us-central1'.
 * Quando undefined, retorna `fallback`.
 */
export function gcpRegion(regionOrZone: string | undefined, fallback: string): string {
  if (!regionOrZone) return fallback;
  const parts = regionOrZone.split('-');
  if (parts.length >= 3 && /^[a-z]$/.test(parts[parts.length - 1])) {
    return parts.slice(0, -1).join('-');
  }
  return regionOrZone;
}
