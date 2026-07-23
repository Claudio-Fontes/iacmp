import type { Example } from '../index.js';

export const s3PresignedUrl: Example = {
  id: 'aws-s3-presigned-url',
  title: 'S3 com presigned URL para upload direto do browser',
  tags: ['aws', 's3', 'presigned-url', 'lambda', 'upload', 's3-request-presigner'],
  validated: true,
  stacks: {
    'stacks/storage/bucket-stack.ts': `import { Stack, Storage } from '@iacmp/core';
const stack = new Stack('uploads-storage');
new Storage.Bucket(stack, 'UploadsBucket', { versioning: false });
export default stack;`,

    'stacks/compute/api-stack.ts': `import { Stack, Fn, Policy, ref } from '@iacmp/core';
const stack = new Stack('uploads-api');
new Fn.Lambda(stack, 'GetUploadUrlFn', {
  runtime: 'nodejs20',
  handler: 'dist/getUploadUrl.handler',
  code: '.',
  environment: { BUCKET_NAME: ref('UploadsBucket', 'Name') },
});
new Policy.IAM(stack, 'GetUploadUrlFnPolicy', {
  attachTo: 'GetUploadUrlFn', attachType: 'lambda',
  statements: [{ effect: 'Allow', actions: ['s3:PutObject', 's3:GetObject'], resources: [ref('UploadsBucket', 'Arn')] }],
});
export default stack;`,
  },
  handlers: {
    'src/getUploadUrl.ts': `import { blob } from '@iacmp/runtime';
const b = blob(process.env.BUCKET_NAME!);
export async function handler(event: any) {
  const key = event.queryStringParameters?.key ?? \`upload-\${Date.now()}\`;
  const url = await b.presignPut(key, { expiresSeconds: 300 });
  return { statusCode: 200, body: JSON.stringify({ url, key }), headers: { 'Access-Control-Allow-Origin': '*' } };
}`,
  },
  notes: [
    'Handler usa o facade @iacmp/runtime (blob().presignPut) — NUNCA @aws-sdk/client-s3 nem @aws-sdk/s3-request-presigner diretamente',
    'presignPut(key, { expiresSeconds }) — a opção é expiresSeconds, NÃO expiresIn (isso é detalhe do SDK cru, escondido pelo facade)',
    'Policy.IAM precisa de s3:PutObject para upload e s3:GetObject para download',
    'resources: [ref("UploadsBucket","Arn")] — NUNCA string com ARN literal',
    "environment: BUCKET_NAME usa ref('UploadsBucket', 'Name') — NUNCA o ID lógico como string literal",
  ],
};
