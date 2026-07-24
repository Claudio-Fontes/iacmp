/**
 * Golden Terraform (.tf.json) tests — GCP.
 *
 * Compara o output do `emitGCPTerraform` (via GCPProvider) com JSONs commitados.
 * É a rede de regressão do provider GCP: enquanto o G1 (redistribuir o
 * gcp-terraform.ts em constructs/) for refactor puro, estes goldens devem ficar
 * byte-idênticos. Golden que muda é bug do trabalho (docs/roadmap-fase2.md §0).
 *
 * Os 2 cenários abaixo foram validados de ponta a ponta com `terraform validate`
 * (provider hashicorp/google) no Passo 0 (§2.2.1).
 *
 * Para regenerar após mudança INTENCIONAL no synth:
 *   UPDATE_GOLDEN=1 npm test --workspace=packages/providers/gcp -- --testPathPattern=golden-tf
 */
import * as fs from 'fs';
import * as path from 'path';
import { Stack, Fn, Storage, Messaging, Monitoring } from '@iacmp/core';
import { GCPProvider } from '../src';

const GOLDEN_DIR = path.join(__dirname, 'golden-tf');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function assertGolden(name: string, actual: string): void {
  const file = path.join(GOLDEN_DIR, `${name}.tf.json`);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual, 'utf-8');
    return;
  }
  const expected = fs.readFileSync(file, 'utf-8');
  expect(actual).toEqual(expected);
}

describe('Golden Terraform (.tf.json) — GCP', () => {
  const provider = new GCPProvider();

  // ── 1. s3-lambda-pipeline ──────────────────────────────────────────────────
  test('s3-lambda-pipeline', () => {
    const stack = new Stack('s3-lambda-pipeline', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'ProcessFn', {
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: 'dist/',
      environment: { DEST_BUCKET: 'OutputBucket.name' },
    });
    new Storage.Bucket(stack, 'InputBucket', {
      versioning: true,
      eventNotifications: [{ lambdaId: 'ProcessFn', events: ['s3:ObjectCreated:*'] }],
    });
    new Storage.Bucket(stack, 'OutputBucket', { versioning: false });
    assertGolden('s3-lambda-pipeline', provider.synthesize(stack, [stack]));
  });

  // ── 2. sns-alarm ───────────────────────────────────────────────────────────
  test('sns-alarm', () => {
    const stack = new Stack('sns-alarm', { region: 'us-east-1' });
    new Fn.Lambda(stack, 'AlertHandler', {
      runtime: 'nodejs20',
      handler: 'alert.handler',
      code: 'dist/',
    });
    new Messaging.Topic(stack, 'AlertsTopic', {
      displayName: 'Alerts',
      subscriptions: [{ protocol: 'lambda', endpoint: 'AlertHandler' }],
    });
    new Monitoring.Alarm(stack, 'ErrorAlarm', {
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      threshold: 10,
      evaluationPeriods: 2,
      periodSeconds: 300,
      comparisonOperator: 'GreaterThanThreshold',
      treatMissingData: 'notBreaching',
      alarmActions: ['AlertsTopic.Arn'],
      dimensions: { FunctionName: 'AlertHandler' },
    });
    assertGolden('sns-alarm', provider.synthesize(stack, [stack]));
  });
});
