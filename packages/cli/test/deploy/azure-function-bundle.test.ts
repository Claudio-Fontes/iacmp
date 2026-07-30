import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildFunctionBundle, AzureFunctionMeta } from '../../src/deploy/azure/function-bundle';
import { renderServiceBusTriggerWrapper } from '../../src/deploy/azure/service-bus-trigger-wrapper';

// ── renderServiceBusTriggerWrapper: adapter isolado via `vm` ─────────────────
// Mesmo padrão usado pelos wrappers GCP (renderGcpFunctionWrapper/renderGcpEventWrapper
// em test/deploy/gcp.test.ts): roda a fonte real do adapter num sandbox, injetando um
// `require('../handler')` fake — sem tocar fs/esbuild reais.
function loadServiceBusWrapper(handlerFn: (event: unknown, ctx: unknown) => unknown): (context: unknown, msg: unknown) => Promise<unknown> {
  const sandboxModule = { exports: {} as unknown };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (p: string) => {
      if (p === '../handler') return { handler: handlerFn };
      throw new Error(`require inesperado no sandbox: ${p}`);
    },
    Buffer,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(renderServiceBusTriggerWrapper(), sandbox);
  return sandboxModule.exports as (context: unknown, msg: unknown) => Promise<unknown>;
}

describe('renderServiceBusTriggerWrapper', () => {
  test('mensagem objeto → body normalizado para string JSON, formato Lambda { Records: [...] }', async () => {
    const handler = jest.fn(async (event: any, _ctx: any) => ({ ok: true, event }));
    const wrapped = loadServiceBusWrapper(handler);

    const msg = { orderId: 42, item: 'widget' };
    const context = { bindingData: { messageId: 'msg-1' } };
    await wrapped(context, msg);

    expect(handler).toHaveBeenCalledTimes(1);
    const [event, ctx] = handler.mock.calls[0];
    expect(ctx).toEqual({});
    expect(event.Records).toHaveLength(1);
    expect(typeof event.Records[0].body).toBe('string');
    expect(JSON.parse(event.Records[0].body)).toEqual(msg);
    expect(event.Records[0].messageId).toBe('msg-1');
  });

  test('mensagem já string → body passa direto (sem re-serializar)', async () => {
    const handler = jest.fn(async (_event: any, _ctx: any) => ({}));
    const wrapped = loadServiceBusWrapper(handler);

    await wrapped({ bindingData: {} }, '{"raw":true}');

    const event = handler.mock.calls[0][0];
    expect(event.Records[0].body).toBe('{"raw":true}');
  });

  test('sem bindingData.messageId → messageId undefined (não quebra)', async () => {
    const handler = jest.fn(async (_event: any, _ctx: any) => ({}));
    const wrapped = loadServiceBusWrapper(handler);

    await wrapped({}, { a: 1 });

    const event = handler.mock.calls[0][0];
    expect(event.Records[0].messageId).toBeUndefined();
  });

  test('exceção do handler PROPAGA (não é engolida) — é o sinal que ativa retry/DLQ do Service Bus', async () => {
    const handler = jest.fn(async (_event: any, _ctx: any) => { throw new Error('processamento falhou'); });
    const wrapped = loadServiceBusWrapper(handler);

    await expect(wrapped({ bindingData: {} }, { x: 1 })).rejects.toThrow('processamento falhou');
  });
});

// ── buildFunctionBundle: empacotamento real (esbuild + zip) num diretório temporário ──
describe('buildFunctionBundle — ServiceBusTrigger', () => {
  let cwd: string;
  let templatePath: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-azure-fn-bundle-'));
    templatePath = path.join(cwd, 'synth-out', 'azure', 'worker-stack.bicep');
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'src', 'worker.ts'),
      `export async function handler(event: any) { return { statusCode: 200, body: '' }; }\n`,
    );
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  function buildDirOf(fn: AzureFunctionMeta): string {
    return path.join(path.dirname(templatePath), '.packaged', fn.functionAppName);
  }

  test('sbTrigger + SEM rotas HTTP → empacota ServiceBusTrigger, NÃO empacota HttpTrigger', () => {
    const fn: AzureFunctionMeta = {
      constructId: 'Worker',
      functionAppName: 'worker',
      handler: 'src/worker.handler',
      code: 'src/worker',
      runtime: 'nodejs20',
      routePatterns: [],
      sbTrigger: { queueName: 'OrderQueue', connectionSetting: 'SERVICEBUS_CONNECTION' },
    };

    const zipPath = buildFunctionBundle(cwd, fn, templatePath);
    expect(zipPath).not.toBeNull();
    expect(fs.existsSync(zipPath!)).toBe(true);

    const dir = buildDirOf(fn);
    expect(fs.existsSync(path.join(dir, 'HttpTrigger'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ServiceBusTrigger', 'function.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ServiceBusTrigger', 'index.js'))).toBe(true);

    const binding = JSON.parse(fs.readFileSync(path.join(dir, 'ServiceBusTrigger', 'function.json'), 'utf-8'));
    expect(binding.bindings).toEqual([
      { type: 'serviceBusTrigger', direction: 'in', name: 'msg', queueName: 'OrderQueue', connection: 'SERVICEBUS_CONNECTION' },
    ]);
  });

  test('sbTrigger + COM rotas HTTP mapeadas → empacota os DOIS (HttpTrigger e ServiceBusTrigger)', () => {
    const fn: AzureFunctionMeta = {
      constructId: 'Worker',
      functionAppName: 'worker',
      handler: 'src/worker.handler',
      code: 'src/worker',
      runtime: 'nodejs20',
      routePatterns: ['/orders'],
      sbTrigger: { queueName: 'OrderQueue', connectionSetting: 'SERVICEBUS_CONNECTION' },
    };

    buildFunctionBundle(cwd, fn, templatePath);

    const dir = buildDirOf(fn);
    expect(fs.existsSync(path.join(dir, 'HttpTrigger', 'function.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ServiceBusTrigger', 'function.json'))).toBe(true);
  });

  test('sem sbTrigger → comportamento inalterado (só HttpTrigger, regressão zero)', () => {
    const fn: AzureFunctionMeta = {
      constructId: 'Handler',
      functionAppName: 'handler',
      handler: 'src/worker.handler',
      code: 'src/worker',
      runtime: 'nodejs20',
      routePatterns: [],
    };

    buildFunctionBundle(cwd, fn, templatePath);

    const dir = buildDirOf(fn);
    expect(fs.existsSync(path.join(dir, 'HttpTrigger', 'function.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ServiceBusTrigger'))).toBe(false);
  });
});
