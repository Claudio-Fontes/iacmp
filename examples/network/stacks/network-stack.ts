import { Stack, Network, Compute } from '@iacmp/core';

const stack = new Stack('network');

const vpc = new Network.VPC(stack, 'VpcPrincipal', {
  cidr: '10.0.0.0/8',
  maxAzs: 3,
});

const bastion = new Compute.Instance(stack, 'Bastion', {
  instanceType: 'small',
  image: 'ubuntu-22.04',
});

const appServer = new Compute.Instance(stack, 'AppServer', {
  instanceType: 'large',
  image: 'ubuntu-22.04',
});

export default stack;
