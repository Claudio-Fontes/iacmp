import { Stack, Compute, Storage } from '@iacmp/core';
import { AzureProvider } from '../src';

describe('AzureProvider', () => {
  test('sintetiza ARM Template', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.$schema).toContain('deploymentTemplate.json');
    expect(tpl.resources[0].type).toBe('Microsoft.Compute/virtualMachines');
    expect(tpl.resources[0].properties.hardwareProfile.vmSize).toBe('Standard_B1s');
  });

  test('Storage.Bucket → Microsoft.Storage/storageAccounts', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Blob', { versioning: false });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('Microsoft.Storage/storageAccounts');
  });
});
