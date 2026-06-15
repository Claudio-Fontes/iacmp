import { Stack, Compute, Storage, Network, Database, Fn, Cache } from '@iacmp/core';
import { TerraformProvider } from '../src';

describe('TerraformProvider', () => {
  test('gera bloco terraform e provider aws', () => {
    const stack = new Stack('test');
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('terraform {');
    expect(hcl).toContain('provider "aws"');
  });

  test('Compute.Instance → resource aws_instance', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ubuntu-22.04' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_instance" "Web"');
    expect(hcl).toContain('t3.medium');
  });

  test('Storage.Bucket → resource aws_s3_bucket', () => {
    const stack = new Stack('test');
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('resource "aws_s3_bucket" "Assets"');
  });

  test('Database.SQL postgres → aws_db_instance com postgres', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'PgDB', { engine: 'postgres' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_db_instance');
    expect(hcl).toContain('postgres');
  });

  test('Database.SQL sqlserver → HCL contém sqlserver', () => {
    const stack = new Stack('test');
    new Database.SQL(stack, 'SqlDB', { engine: 'sqlserver' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('sqlserver');
  });

  test('Compute.Instance windows-2022 → HCL contém windows_2022', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Win', { instanceType: 'small', image: 'windows-2022' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('windows_2022');
  });

  test('Cache.Redis → HCL contém aws_elasticache_replication_group', () => {
    const stack = new Stack('test');
    new Cache.Redis(stack, 'RedisCache', { nodeType: 'small' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_elasticache_replication_group');
  });

  test('Fn.Lambda → HCL contém aws_lambda_function', () => {
    const stack = new Stack('test');
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const hcl = new TerraformProvider().synthesize(stack);
    expect(hcl).toContain('aws_lambda_function');
  });
});
