import type { Example } from '../index.js';

export const blobTriggerContainer: Example = {
  id: 'azure-blob-trigger-container',
  title: 'Azure Blob Storage com trigger Container App (via Event Grid)',
  tags: ['azure', 'blob', 'storage', 'trigger', 'container-app', 'event-grid', 's3'],
  validated: true,
  stacks: {
    'stacks/storage/bucket-stack.ts': `import { Stack, Storage } from '@iacmp/core';
const stack = new Stack('uploads-storage');
new Storage.Bucket(stack, 'UploadsBucket', {
  versioning: false,
  trigger: { lambdaId: 'ProcessFileFn', events: ['s3:ObjectCreated:*'] },
});
export default stack;`,

    'stacks/compute/processor-stack.ts': `import { Stack, Compute, Policy, ref } from '@iacmp/core';
const stack = new Stack('uploads-processor');
new Compute.Container(stack, 'ProcessFileFn', {
  image: 'processor:latest',
  port: 8080,
  environment: { BUCKET_NAME: ref('UploadsBucket', 'Name') },
});
new Policy.IAM(stack, 'ProcessFileFnPolicy', {
  attachTo: 'ProcessFileFn', attachType: 'container',
  statements: [{ effect: 'Allow', actions: ['s3:GetObject'], resources: [ref('UploadsBucket', 'Arn')] }],
});
export default stack;`,
  },
  handlers: {
    'src/processFile.ts': `export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    // Azure normaliza o evento no mesmo formato S3 — usa record.s3.object.key
    const key = decodeURIComponent((record.s3?.object?.key ?? '').replace(/\\+/g, ' '));
    const bucket = record.s3?.bucket?.name ?? process.env.BUCKET_NAME;
    console.log('Processando blob:', bucket, key);
  }
}`,
  },
  notes: [
    'Evento Azure Blob via Event Grid é normalizado pelo synth para o mesmo formato S3: record.s3.object.key',
    'NUNCA usar record.blob.name — não existe no formato normalizado',
    'Policy.IAM com s3:GetObject obrigatória para leitura do blob',
    'resources: [ref("UploadsBucket","Arn")] — NUNCA string literal',
    "environment: BUCKET_NAME usa ref('UploadsBucket', 'Name') — NUNCA o ID lógico como string literal",
    'trigger.lambdaId referencia o ID lógico do Container ou Lambda em outra stack',
  ],
};
