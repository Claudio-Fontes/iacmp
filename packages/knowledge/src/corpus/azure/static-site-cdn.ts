import type { Example } from '../index.js';

export const staticSiteCdn: Example = {
  id: 'azure-static-site-cdn',
  title: 'Azure Static Website (Storage $web) + Front Door CDN',
  tags: ['azure', 'storage', 'cdn', 'static-site', 'website', 'spa', 'react'],
  // validado em deploy real (bateria p06): GET no endpoint retornou 200 com o index.html
  validated: true,
  stacks: {
    'stacks/storage/frontend-stack.ts': `import { Stack, Storage, Network } from '@iacmp/core';
const stack = new Stack('frontend-cdn');
// No Azure, site estático + CDN é o padrão normal: o CDN aponta pro endpoint
// PÚBLICO $web do storage account (não é OAC — essa regra é AWS-only, ver
// core/validate.ts). Storage.Bucket e Network.CDN na MESMA stack — bucketRef
// é GetAtt local, não cross-stack.
new Storage.Bucket(stack, 'FrontendBucket', {
  versioning: false,
  websiteHosting: true,
});
new Network.CDN(stack, 'FrontendCDN', {
  origins: [{ bucketRef: 'FrontendBucket' }],
});
export default stack;`,
  },
  handlers: {},
  notes: [
    'Azure: websiteHosting: true + Network.CDN via bucketRef NA MESMA STACK — o oposto do padrão AWS (lá é mutuamente exclusivo com OAC). core/validate.ts tem a exceção explícita: a regra K só dispara quando profile.cloud é "aws" ou ausente.',
    'websiteHosting ativa o endpoint $web (data-plane, fora do ARM) — o deploy roda `az storage blob service-properties update --static-website` pós-deploy para ligar o index/error document',
    'Network.CDN{origins:[{bucketRef}]} é a forma explícita do atalho bucketRef top-level — ambas equivalentes (Network.CDN normaliza no constructor)',
    'accountTier free: sem Front Door (indisponível em Free Trial) — o synth serve direto do endpoint $web do storage (FrontendCDN Url aponta pro primaryEndpoints.web)',
    'accountTier standard: cria Microsoft.Cdn/profiles (Standard_AzureFrontDoor) com origin apontando pro mesmo $web',
    'Sem handlers — este exemplo é só a stack de hosting; o conteúdo (build do React/Vite) é enviado por upload direto ao container $web, não por um construct',
  ],
};
