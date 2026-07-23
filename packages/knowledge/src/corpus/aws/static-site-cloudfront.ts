import type { Example } from '../index.js';

export const staticSiteCloudfront: Example = {
  id: 'aws-static-site-cloudfront',
  title: 'SPA React + S3 + CloudFront CDN',
  tags: ['aws', 's3', 'cloudfront', 'cdn', 'react', 'spa', 'static-site'],
  validated: true,
  stacks: {
    'stacks/storage/frontend-stack.ts': `import { Stack, Storage, Network } from '@iacmp/core';
const stack = new Stack('frontend-cdn');
// Bucket PRIVADO servido via CloudFront/OAC + Network.CDN na MESMA stack (bucketRef = GetAtt local)
new Storage.Bucket(stack, 'FrontendBucket', {
  versioning: false,
  websiteHosting: false,
});
new Network.CDN(stack, 'FrontendCDN', {
  bucketRef: 'FrontendBucket',
  defaultRootObject: 'index.html',
});
export default stack;`,
  },
  handlers: {},
  notes: [
    'Servido via CloudFront/OAC → o bucket fica PRIVADO: websiteHosting: false (o CDN serve o defaultRootObject). websiteHosting: true tornaria o bucket público e conflita com OAC — nunca os dois juntos.',
    'Storage.Bucket e Network.CDN na MESMA stack — bucketRef é GetAtt local, não cross-stack',
    'Network.CDN (não Storage.CDN — não existe)',
    'Sem certificateArn o CloudFront usa *.cloudfront.net — NUNCA gerar placeholder de ARN',
    'Para SPA com React Router: adicionar errorPage: "/index.html" nas props do CDN',
  ],
};
