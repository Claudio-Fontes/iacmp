import { Stack, Compute, Storage, Network, Database, Fn } from '../src';

describe('Stack', () => {
  test('cria stack vazia', () => {
    const stack = new Stack('minha-stack');
    expect(stack.name).toBe('minha-stack');
    expect(stack.constructs).toHaveLength(0);
  });

  test('adiciona constructs', () => {
    const stack = new Stack('test');
    new Compute.Instance(stack, 'Web', { instanceType: 'small', image: 'ubuntu-22.04' });
    new Storage.Bucket(stack, 'Assets', { versioning: true });
    expect(stack.constructs).toHaveLength(2);
  });
});

describe('Constructs', () => {
  let stack: Stack;
  beforeEach(() => { stack = new Stack('test'); });

  test('Compute.Instance', () => {
    const c = new Compute.Instance(stack, 'Web', { instanceType: 'medium', image: 'ubuntu-22.04' });
    expect(c.type).toBe('Compute.Instance');
    expect(c.id).toBe('Web');
    expect((c.props as any).instanceType).toBe('medium');
  });

  test('Storage.Bucket', () => {
    const c = new Storage.Bucket(stack, 'Assets', { versioning: true, publicAccess: false });
    expect(c.type).toBe('Storage.Bucket');
    expect((c.props as any).versioning).toBe(true);
  });

  test('Network.VPC', () => {
    const c = new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16', maxAzs: 3 });
    expect(c.type).toBe('Network.VPC');
    expect((c.props as any).cidr).toBe('10.0.0.0/16');
  });

  test('Database.SQL', () => {
    const c = new Database.SQL(stack, 'DB', { engine: 'postgres', multiAz: true });
    expect(c.type).toBe('Database.SQL');
    expect((c.props as any).engine).toBe('postgres');
  });

  test('Fn.Lambda', () => {
    const c = new Fn.Lambda(stack, 'Handler', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });
    expect(c.type).toBe('Function.Lambda');
    expect((c.props as any).runtime).toBe('nodejs20');
  });
});
