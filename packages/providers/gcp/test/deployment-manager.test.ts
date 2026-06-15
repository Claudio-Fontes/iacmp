import { Stack, Compute, Storage, Network, Database, Fn } from '@iacmp/core';
import { GCPProvider } from '../src';

describe('GCPProvider', () => {
  test('Compute.Instance ubuntu-22.04 → type compute.v1.instance e sourceImage contém ubuntu', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'VM', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('compute.v1.instance');
    expect(tpl.resources[0].properties.disks[0].initializeParams.sourceImage).toContain('ubuntu');
  });

  test('Compute.Instance windows-2022 → sourceImage contém windows', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'WinVM', { instanceType: 'small', image: 'windows-2022' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.disks[0].initializeParams.sourceImage).toContain('windows');
  });

  test('Storage.Bucket → type storage.v1.bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Bucket', { versioning: false });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('storage.v1.bucket');
  });

  test('Database.SQL mysql → type sqladmin.v1beta4.instance e databaseVersion contém MYSQL', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'MySQLDB', { engine: 'mysql' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('sqladmin.v1beta4.instance');
    expect(tpl.resources[0].properties.databaseVersion).toContain('MYSQL');
  });

  test('Database.SQL postgres → databaseVersion contém POSTGRES', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.databaseVersion).toContain('POSTGRES');
  });

  test('Database.SQL sqlserver → databaseVersion contém SQLSERVER', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].properties.databaseVersion).toContain('SQLSERVER');
  });

  test('Fn.Lambda → type cloudfunctions.v2.function', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('cloudfunctions.v2.function');
  });

  test('Network.VPC → type compute.v1.network', () => {
    const stack = new Stack('test');
    new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16' });
    const tpl = new GCPProvider().synthesize(stack) as any;
    expect(tpl.resources[0].type).toBe('compute.v1.network');
  });
});
