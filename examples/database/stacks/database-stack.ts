import { Stack, Network, Database } from '@iacmp/core';

const stack = new Stack('database');

const vpc = new Network.VPC(stack, 'VPC', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,
});

const db = new Database.SQL(stack, 'Principal', {
  engine: 'postgres',
  instanceType: 'medium',
  multiAz: true,
});

const replica = new Database.SQL(stack, 'Replica', {
  engine: 'postgres',
  instanceType: 'small',
  multiAz: false,
});

export default stack;
