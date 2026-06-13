import { Stack, Compute, Storage, Network, Database, Fn } from '@iacmp/core';
import { AWSProvider } from '../src';

describe('AWSProvider', () => {
  let stack: Stack;
  let provider: AWSProvider;

  beforeEach(() => {
    stack = new Stack('test-stack', { region: 'us-east-1' });
    provider = new AWSProvider();
  });

  test('sintetiza stack vazia', () => {
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.AWSTemplateFormatVersion).toBe('2010-09-09');
    expect(tpl.Resources).toEqual({});
  });

  test('Compute.Instance → AWS::EC2::Instance', () => {
    new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ubuntu-22.04' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Web.Type).toBe('AWS::EC2::Instance');
    expect(tpl.Resources.Web.Properties.InstanceType).toBe('t3.small');
  });

  test('Storage.Bucket → AWS::S3::Bucket com versioning', () => {
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Assets.Type).toBe('AWS::S3::Bucket');
    expect(tpl.Resources.Assets.Properties.VersioningConfiguration.Status).toBe('Enabled');
  });

  test('Storage.Bucket → AWS::S3::Bucket sem versioning', () => {
    new Storage.Bucket(stack, 'Assets', { versioning: false });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Assets.Properties.VersioningConfiguration.Status).toBe('Suspended');
  });

  test('Network.VPC → AWS::EC2::VPC', () => {
    new Network.VPC(stack, 'Rede', { cidr: '192.168.0.0/16' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Rede.Type).toBe('AWS::EC2::VPC');
    expect(tpl.Resources.Rede.Properties.CidrBlock).toBe('192.168.0.0/16');
  });

  test('Database.SQL mysql → AWS::RDS::DBInstance', () => {
    new Database.SQL(stack, 'DB', { engine: 'mysql' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.DB.Type).toBe('AWS::RDS::DBInstance');
    expect(tpl.Resources.DB.Properties.Engine).toBe('mysql');
  });

  test('Fn.Lambda → AWS::Lambda::Function', () => {
    new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    const tpl = provider.synthesize(stack) as any;
    expect(tpl.Resources.Handler.Type).toBe('AWS::Lambda::Function');
    expect(tpl.Resources.Handler.Properties.Runtime).toBe('nodejs20.x');
  });

  test('instanceType mapping: small→t3.small, medium→t3.medium, large→t3.large', () => {
    (['small', 'medium', 'large'] as const).forEach((size, i) => {
      const s = new Stack(`s${i}`);
      new Compute.Instance(s, 'W', { instanceType: size, image: 'img' });
      const tpl = provider.synthesize(s) as any;
      const expected = { small: 't3.small', medium: 't3.medium', large: 't3.large' }[size];
      expect(tpl.Resources.W.Properties.InstanceType).toBe(expected);
    });
  });
});
