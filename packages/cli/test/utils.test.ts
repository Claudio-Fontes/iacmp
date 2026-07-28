import { resolveProviderRegion } from '../src/utils';

describe('resolveProviderRegion', () => {
  test('aws usa region (default us-east-1)', () => {
    expect(resolveProviderRegion('aws', { region: 'sa-east-1' })).toBe('sa-east-1');
    expect(resolveProviderRegion('aws', {})).toBe('us-east-1');
    expect(resolveProviderRegion('aws', null)).toBe('us-east-1');
  });

  test('azure usa azureRegion (default eastus2), nunca a region AWS', () => {
    expect(resolveProviderRegion('azure', { region: 'us-east-1', azureRegion: 'westeurope' })).toBe('westeurope');
    expect(resolveProviderRegion('azure', { region: 'us-east-1' })).toBe('eastus2');
  });

  test('gcp usa gcpRegion (default us-central1) e NÃO herda a region AWS', () => {
    expect(resolveProviderRegion('gcp', { region: 'us-east-1', gcpRegion: 'southamerica-east1' })).toBe('southamerica-east1');
    // o bug corrigido: sem gcpRegion, jamais cair em us-east-1 (região AWS, inválida no GCP)
    expect(resolveProviderRegion('gcp', { region: 'us-east-1' })).toBe('us-central1');
  });
});
