import { Stack, Compute, Storage, Network, Database, Fn, Cache } from '@iacmp/core';
import { TerraformProvider } from '../src';

function synth(stack: Stack): Record<string, unknown> {
  return JSON.parse(new TerraformProvider().synthesize(stack));
}

describe('TerraformProvider (via grafo aws)', () => {
  test('gera bloco terraform e provider aws', () => {
    const stack = new Stack('test');
    const tf = synth(stack);
    expect(tf).toHaveProperty('terraform');
    expect((tf as any).terraform?.required_providers?.aws).toBeDefined();
    expect(tf).toHaveProperty('provider');
    expect((tf as any).provider?.aws).toBeDefined();
  });

  test('Compute.Instance → resource aws_ec2_instance com instance_type t3.medium', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ubuntu-22.04' });
    const tf = synth(stack);
    const instances = (tf as any).resource?.aws_ec2_instance;
    expect(instances).toBeDefined();
    const inst = Object.values(instances as Record<string, unknown>)[0] as Record<string, unknown>;
    expect(inst.instance_type).toBe('t3.medium');
  });

  test('Storage.Bucket → resource aws_s3_bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    const tf = synth(stack);
    expect((tf as any).resource?.aws_s3_bucket).toBeDefined();
  });

  test('Database.SQL postgres → aws_db_instance', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const tf = synth(stack);
    expect((tf as any).resource?.aws_db_instance).toBeDefined();
  });

  test('Database.SQL sqlserver → aws_db_instance com engine sqlserver', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const result = new TerraformProvider().synthesize(stack);
    expect(result).toContain('sqlserver');
  });

  test('Database.DynamoDB sem partitionKeyType → attribute type S', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id' });
    const tf = synth(stack);
    const tables = (tf as any).resource?.aws_dynamodb_table;
    expect(tables).toBeDefined();
    const table = Object.values(tables as Record<string, unknown>)[0] as Record<string, unknown>;
    const attrs = table.attribute as Array<{ name: string; type: string }>;
    const pk = attrs?.find(a => a.name === 'id');
    expect(pk?.type).toBe('S');
  });

  test('Database.DynamoDB com partitionKeyType N → attribute type N (regressao: tipo sempre era hardcoded como String)', () => {
    const stack = new Stack('test');
    new Database.DynamoDB(stack, 'Tab', { partitionKey: 'id', partitionKeyType: 'N' });
    const tf = synth(stack);
    const tables = (tf as any).resource?.aws_dynamodb_table;
    const table = Object.values(tables as Record<string, unknown>)[0] as Record<string, unknown>;
    const attrs = table.attribute as Array<{ name: string; type: string }>;
    const pk = attrs?.find(a => a.name === 'id');
    expect(pk?.type).toBe('N');
  });

  test('Compute.Instance windows-2022 → instance usa imagem Windows Server 2022', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Win', { instanceType: 'small', image: 'windows-2022' });
    const result = new TerraformProvider().synthesize(stack);
    expect(result).toContain('Windows_Server-2022');
  });

  test('Cache.Redis → resource aws_elasticache_replication_group', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const tf = synth(stack);
    expect((tf as any).resource?.aws_elasticache_replication_group).toBeDefined();
  });

  test('Fn.Lambda → resource aws_lambda_function', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tf = synth(stack);
    expect((tf as any).resource?.aws_lambda_function).toBeDefined();
  });

  test('ARCH-06: construct desconhecido emite warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const stack = new Stack('test');
    stack.addConstruct({ id: 'X', type: 'Foo.Bar', props: {} } as any);
    new TerraformProvider().synthesize(stack);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'Foo.Bar' nao suportado"));
    warnSpy.mockRestore();
  });

  test('Fn.ApiGateway com authorizerLambdaId → aws_api_gateway_v2_authorizer e authorization_type CUSTOM', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'AuthFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.Lambda(stack, 'HelloFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    new Fn.ApiGateway(stack, 'Api', {
      name: 'my-api',
      authorizerLambdaId: 'AuthFn',
      routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloFn' }],
    });
    const tf = synth(stack);
    expect((tf as any).resource?.aws_api_gateway_v2_authorizer).toBeDefined();
    const result = new TerraformProvider().synthesize(stack);
    expect(result).toContain('CUSTOM');
  });

  test('saida e JSON valido com estrutura terraform standard', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'B', { versioning: false });
    const result = new TerraformProvider().synthesize(stack);
    expect(() => JSON.parse(result)).not.toThrow();
    const tf = JSON.parse(result);
    expect(tf).toHaveProperty('terraform');
    expect(tf).toHaveProperty('provider');
  });
});
