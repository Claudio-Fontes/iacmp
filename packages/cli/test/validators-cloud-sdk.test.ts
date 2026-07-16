import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateHandlerCloudSdk } from '../src/validators';

describe('validateHandlerCloudSdk — dois mundos em synth-time (caso main1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-sdk-'));
    fs.mkdirSync(path.join(dir, 'src'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) =>
    fs.writeFileSync(path.join(dir, 'src', name), content);

  test('projeto AWS (@aws-sdk) sintetizado para azure → erro com orientação', () => {
    write('getUploadUrl.ts', "import { S3Client } from '@aws-sdk/client-s3';");
    const errs = validateHandlerCloudSdk(dir, 'azure');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('getUploadUrl.ts');
    expect(errs[0]).toContain('iacmp ai --provider azure');
  });

  test('projeto Azure (@azure/*) sintetizado para aws → erro espelho', () => {
    write('tables.ts', "import { TableClient } from '@azure/data-tables';");
    const errs = validateHandlerCloudSdk(dir, 'aws');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('iacmp ai --provider aws');
  });

  test('SDK certo para o provider → sem erro (nas duas direções)', () => {
    write('a.ts', "import { S3Client } from '@aws-sdk/client-s3';");
    expect(validateHandlerCloudSdk(dir, 'aws')).toEqual([]);
    fs.rmSync(path.join(dir, 'src', 'a.ts'));
    write('b.ts', "import { BlobServiceClient } from '@azure/storage-blob';");
    expect(validateHandlerCloudSdk(dir, 'azure')).toEqual([]);
  });

  test('handler cloud-neutro (sem SDK) → sem erro nos dois providers', () => {
    write('pure.ts', 'export const handler = async () => ({ statusCode: 200 });');
    expect(validateHandlerCloudSdk(dir, 'aws')).toEqual([]);
    expect(validateHandlerCloudSdk(dir, 'azure')).toEqual([]);
  });

  test('providers sem regra (gcp/terraform) → não valida', () => {
    write('x.ts', "import { S3Client } from '@aws-sdk/client-s3';");
    expect(validateHandlerCloudSdk(dir, 'gcp')).toEqual([]);
    expect(validateHandlerCloudSdk(dir, 'terraform')).toEqual([]);
  });

  test('projeto sem src/ → sem erro', () => {
    fs.rmSync(path.join(dir, 'src'), { recursive: true });
    expect(validateHandlerCloudSdk(dir, 'azure')).toEqual([]);
  });
});
