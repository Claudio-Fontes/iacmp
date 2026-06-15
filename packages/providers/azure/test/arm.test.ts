import { Stack, Compute, Storage, Database, Cache, Messaging } from '@iacmp/core';
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

  test('Compute.Instance windows-2022 → publisher MicrosoftWindowsServer e adminUsername adminuser', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const imgRef = tpl.resources[0].properties.storageProfile.imageReference;
    expect(imgRef.publisher).toBe('MicrosoftWindowsServer');
    const adminUser = tpl.resources[0].properties.osProfile.adminUsername;
    expect(adminUser).toBe('adminuser');
  });

  test('Compute.Instance ubuntu-22.04 → publisher Canonical e adminUsername azureuser', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'UbuntuVM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    const imgRef = tpl.resources[0].properties.storageProfile.imageReference;
    expect(imgRef.publisher).toBe('Canonical');
    const adminUser = tpl.resources[0].properties.osProfile.adminUsername;
    expect(adminUser).toBe('azureuser');
  });

  test('Database.SQL mysql → type contém DBforMySQL', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('DBforMySQL');
  });

  test('Database.SQL sqlserver → type contém Sql/servers', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('Sql/servers');
  });

  test('Cache.Redis → type Microsoft.Cache/Redis', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('Microsoft.Cache/redis');
  });

  test('Messaging.Queue → type contém ServiceBus', () => {
    const stack = new Stack('test');
    new Messaging.Queue(stack, 'MyQueue', {});
    const tpl = new AzureProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toContain('ServiceBus');
  });
});
