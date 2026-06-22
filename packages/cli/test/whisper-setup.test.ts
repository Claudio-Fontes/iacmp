jest.mock('https');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { EventEmitter } from 'events';
import { upsertEnvVar, downloadFile } from '../src/utils/whisper-setup';

const mockedHttps = https as jest.Mocked<typeof https>;

describe('upsertEnvVar', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-whisper-setup-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('cria .env a partir do .env.example quando .env nao existe', () => {
    fs.writeFileSync(path.join(dir, '.env.example'), 'ANTHROPIC_API_KEY=\n');
    upsertEnvVar(dir, 'IACMP_WHISPER_MODEL', '/models/ggml-base.bin');

    const content = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=');
    expect(content).toContain('IACMP_WHISPER_MODEL=/models/ggml-base.bin');
  });

  test('cria .env do zero quando nao ha .env nem .env.example', () => {
    upsertEnvVar(dir, 'IACMP_WHISPER_MODEL', '/models/ggml-base.bin');
    const content = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(content).toContain('IACMP_WHISPER_MODEL=/models/ggml-base.bin');
  });

  test('atualiza valor de uma chave existente sem duplicar a linha', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'IACMP_WHISPER_MODEL=/old/path.bin\nOUTRA=1\n');
    upsertEnvVar(dir, 'IACMP_WHISPER_MODEL', '/new/path.bin');

    const content = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(content).toContain('IACMP_WHISPER_MODEL=/new/path.bin');
    expect(content).not.toContain('/old/path.bin');
    expect(content.match(/IACMP_WHISPER_MODEL=/g)).toHaveLength(1);
    expect(content).toContain('OUTRA=1');
  });

  test('adiciona a chave ao final quando .env existe mas nao tem a chave', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test\n');
    upsertEnvVar(dir, 'IACMP_WHISPER_MODEL', '/models/ggml-base.bin');

    const content = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
    expect(content).toContain('ANTHROPIC_API_KEY=sk-ant-test');
    expect(content).toContain('IACMP_WHISPER_MODEL=/models/ggml-base.bin');
  });
});

function fakeResponse(opts: { statusCode: number; location?: string; body?: string }) {
  const res = new EventEmitter() as unknown as { statusCode: number; headers: Record<string, string>; pipe: (w: fs.WriteStream) => void };
  res.statusCode = opts.statusCode;
  res.headers = opts.location ? { location: opts.location } : {};
  res.pipe = (writable: fs.WriteStream) => {
    writable.write(opts.body ?? '');
    writable.end();
  };
  return res;
}

describe('downloadFile', () => {
  let dir: string;
  let dest: string;

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-whisper-download-'));
    dest = path.join(dir, 'model.bin');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('grava o arquivo quando a resposta e 200', async () => {
    mockedHttps.get.mockImplementation(((_url: string, cb: (res: unknown) => void) => {
      cb(fakeResponse({ statusCode: 200, body: 'conteudo-do-modelo' }));
      return new EventEmitter() as never;
    }) as never);

    await downloadFile('https://example.com/model.bin', dest);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('conteudo-do-modelo');
  });

  test('rejeita e remove arquivo parcial quando o status nao e 200', async () => {
    mockedHttps.get.mockImplementation(((_url: string, cb: (res: unknown) => void) => {
      cb(fakeResponse({ statusCode: 404 }));
      return new EventEmitter() as never;
    }) as never);

    await expect(downloadFile('https://example.com/model.bin', dest)).rejects.toThrow('HTTP 404');
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('segue redirecionamento (302 com location)', async () => {
    let callCount = 0;
    mockedHttps.get.mockImplementation(((url: string, cb: (res: unknown) => void) => {
      callCount++;
      if (url === 'https://example.com/model.bin') {
        cb(fakeResponse({ statusCode: 302, location: 'https://cdn.example.com/model.bin' }));
      } else {
        cb(fakeResponse({ statusCode: 200, body: 'conteudo-redirecionado' }));
      }
      return new EventEmitter() as never;
    }) as never);

    await downloadFile('https://example.com/model.bin', dest);
    expect(callCount).toBe(2);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('conteudo-redirecionado');
  });
});
