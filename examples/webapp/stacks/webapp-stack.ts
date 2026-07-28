import { Stack, Storage, Fn, Network } from '@iacmp/core';

const stack = new Stack('webapp');

const cdn = new Network.VPC(stack, 'Rede', { cidr: '10.0.0.0/16' });

const bucket = new Storage.Bucket(stack, 'SiteBucket', {
  versioning: false,
  publicAccess: true,
});

const assets = new Storage.Bucket(stack, 'AssetsBucket', {
  versioning: true,
  publicAccess: false,
});

export default stack;
