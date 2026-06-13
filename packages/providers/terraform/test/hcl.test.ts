import { Stack, Compute, Storage, Network } from '@iacmp/core';
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
});
