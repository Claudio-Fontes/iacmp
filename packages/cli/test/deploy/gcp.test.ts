jest.mock('child_process');
jest.mock('fs');

import * as cp from 'child_process';
import * as fs from 'fs';
import * as vm from 'vm';
import * as os from 'os';
import * as path from 'path';
import {
  gcpExecutor,
  resolveProjectId,
  ensureComputeServiceAccountRoles,
  ensureRequiredApis,
  REQUIRED_GCP_APIS,
  renderGcpFunctionWrapper,
  renderGcpEventWrapper,
  hashFunctionBundle,
  versionedZipObject,
  patchFunctionZipObjects,
} from '../../src/deploy/gcp';
import { DeployContext, DestroyContext } from '../../src/deploy/types';
import type { GCPFunctionMeta } from '@iacmp/provider-gcp';

const mockedCp = cp as jest.Mocked<typeof cp>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('resolveProjectId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('usa o projectId configurado quando fornecido, sem chamar gcloud', () => {
    expect(resolveProjectId('meu-projeto')).toBe('meu-projeto');
    expect(mockedCp.execFileSync).not.toHaveBeenCalled();
  });

  test('cai para `gcloud config get-value project` quando não configurado', () => {
    mockedCp.execFileSync.mockReturnValue('projeto-default\n' as any);
    expect(resolveProjectId(undefined)).toBe('projeto-default');
  });

  test('lança erro claro quando gcloud também não tem projeto configurado', () => {
    mockedCp.execFileSync.mockReturnValue('(unset)\n' as any);
    expect(() => resolveProjectId(undefined)).toThrow('projectId');
  });

  test('lança erro claro quando o comando gcloud falha', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('gcloud not found'); });
    expect(() => resolveProjectId(undefined)).toThrow('projectId');
  });
});

describe('ensureRequiredApis', () => {
  beforeEach(() => jest.resetAllMocks());

  test('habilita só as APIs faltantes num único `services enable`', () => {
    mockedCp.execFileSync.mockImplementation((_bin: any, args: any) => {
      const a = (args as string[]).join(' ');
      if (a.includes('services list')) return 'cloudfunctions.googleapis.com\nrun.googleapis.com\ncloudbuild.googleapis.com\n' as any;
      return '' as any; // services enable
    });
    ensureRequiredApis('meu-projeto');

    const enableCall = mockedCp.execFileSync.mock.calls.find((c) => (c[1] as string[]).includes('enable'));
    expect(enableCall).toBeDefined();
    const args = enableCall![1] as string[];
    expect(args).toContain('apigateway.googleapis.com'); // faltava → habilita (era o erro do usuário)
    expect(args).toContain('compute.googleapis.com');    // faltava → habilita
    expect(args).not.toContain('cloudfunctions.googleapis.com'); // já habilitada → não repete
  });

  test('não chama `enable` quando todas as APIs já estão habilitadas', () => {
    mockedCp.execFileSync.mockImplementation((_bin: any, args: any) =>
      (args as string[]).join(' ').includes('services list') ? (REQUIRED_GCP_APIS.join('\n') as any) : ('' as any),
    );
    ensureRequiredApis('meu-projeto');
    expect(mockedCp.execFileSync.mock.calls.some((c) => (c[1] as string[]).includes('enable'))).toBe(false);
  });
});

describe('ensureComputeServiceAccountRoles', () => {
  beforeEach(() => jest.resetAllMocks());

  const ALL_ROLES = [
    'roles/cloudbuild.builds.builder', 'roles/logging.logWriter', 'roles/artifactregistry.writer',
    'roles/storage.objectAdmin', 'roles/datastore.user', 'roles/pubsub.editor',
    'roles/secretmanager.secretAccessor', 'roles/cloudsql.client', 'roles/monitoring.editor',
    'roles/run.invoker',
  ];

  function mockGcloud(projectNumber: string | null, currentRoles: string[]) {
    mockedCp.execFileSync.mockImplementation((_bin: any, args: any) => {
      const a = (args as string[]).join(' ');
      if (a.includes('describe')) {
        if (projectNumber === null) throw new Error('sem projeto');
        return projectNumber as any;
      }
      if (a.includes('get-iam-policy')) return currentRoles.join('\n') as any;
      return '' as any; // add-iam-policy-binding
    });
  }

  const rolesAdicionadas = () =>
    mockedCp.execFileSync.mock.calls
      .filter((c) => (c[1] as string[]).includes('add-iam-policy-binding'))
      .map((c) => (c[1] as string[]).find((x) => x.startsWith('--role='))!.replace('--role=', ''));

  /**
   * Menor privilégio (auditoria P1-01, 2026-08-01): as roles saem dos RECURSOS
   * que o artefato realmente cria, não de um superconjunto fixo. Um projeto só
   * com function+bucket não recebe acesso a Pub/Sub, Secret Manager e Cloud SQL.
   */
  // `fs` é mockado neste arquivo (jest.mock('fs')): o helper escreve o artefato
  // com o fs REAL e programa o mock para devolvê-lo ao preflight.
  function synthDirWith(resourceTypes: string[]): string {
    const realFs = jest.requireActual('fs') as typeof import('fs');
    const realOs = jest.requireActual('os') as typeof import('os');
    const realPath = jest.requireActual('path') as typeof import('path');
    const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'iacmp-gcp-preflight-'));
    const resource: Record<string, unknown> = {};
    for (const t of resourceTypes) resource[t] = { x: {} };
    const content = JSON.stringify({ resource });
    realFs.writeFileSync(realPath.join(dir, 'stack.tf.json'), content);
    (fs.readdirSync as unknown as jest.Mock).mockReturnValue(['stack.tf.json']);
    (fs.readFileSync as unknown as jest.Mock).mockReturnValue(content);
    return dir;
  }

  test('concede só as roles exigidas pelos recursos do artefato (menor privilégio)', () => {
    mockGcloud('123456', ['roles/cloudbuild.builds.builder', 'roles/logging.logWriter']);
    const dir = synthDirWith(['google_cloudfunctions2_function', 'google_storage_bucket']);
    ensureComputeServiceAccountRoles('meu-projeto', dir);

    const added = rolesAdicionadas();
    expect(added).not.toContain('roles/cloudbuild.builds.builder'); // já tinha
    expect(added).toContain('roles/storage.objectAdmin');           // tem bucket
    expect(added).toContain('roles/run.invoker');                   // tem function
    // NÃO concede o que o projeto não usa:
    expect(added).not.toContain('roles/pubsub.editor');
    expect(added).not.toContain('roles/secretmanager.secretAccessor');
    expect(added).not.toContain('roles/cloudsql.client');
    expect(added).not.toContain('roles/datastore.user');
    const anyAdd = mockedCp.execFileSync.mock.calls.find((c) => (c[1] as string[]).includes('add-iam-policy-binding'));
    expect((anyAdd![1] as string[]).join(' ')).toContain('123456-compute@developer.gserviceaccount.com');
  });

  test('artefato com Pub/Sub e Secret Manager ganha as roles correspondentes', () => {
    mockGcloud('123456', []);
    const dir = synthDirWith(['google_pubsub_topic', 'google_secret_manager_secret', 'google_sql_database_instance']);
    ensureComputeServiceAccountRoles('meu-projeto', dir);
    const added = rolesAdicionadas();
    expect(added).toContain('roles/pubsub.editor');
    expect(added).toContain('roles/secretmanager.secretAccessor');
    expect(added).toContain('roles/cloudsql.client');
    expect(added).not.toContain('roles/monitoring.editor'); // sem Monitoring no artefato
  });

  test('sem diretório de artefatos, concede só as roles base de build', () => {
    mockGcloud('123456', []);
    ensureComputeServiceAccountRoles('meu-projeto');
    const added = rolesAdicionadas();
    expect(added).toEqual(expect.arrayContaining(['roles/cloudbuild.builds.builder', 'roles/logging.logWriter', 'roles/artifactregistry.writer']));
    expect(added).toHaveLength(3);
  });

  test('não concede nada quando a SA já tem todas as roles (idempotente)', () => {
    mockGcloud('123456', ALL_ROLES);
    const dir = synthDirWith(['google_cloudfunctions2_function', 'google_storage_bucket', 'google_pubsub_topic']);
    ensureComputeServiceAccountRoles('meu-projeto', dir);
    expect(rolesAdicionadas()).toHaveLength(0);
  });

  test('pula graciosamente (sem conceder) quando não resolve o número do projeto', () => {
    mockGcloud(null, []);
    ensureComputeServiceAccountRoles('meu-projeto');
    expect(rolesAdicionadas()).toHaveLength(0);
  });
});

describe('gcpExecutor.describeStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  test('deployed:true quando o tfstate compartilhado tem recursos', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ resources: [{ instances: [{}] }] }) as any);
    expect(gcpExecutor.describeStatus!('main-stack', { cwd: '/tmp' })).toEqual({ deployed: true });
  });

  test('deployed:false quando o tfstate está vazio (state pós-destroy)', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ resources: [] }) as any);
    expect(gcpExecutor.describeStatus!('main-stack', { cwd: '/tmp' })).toEqual({ deployed: false });
  });

  test('deployed:false quando não há tfstate (nunca deployado)', () => {
    mockedFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(gcpExecutor.describeStatus!('main-stack', { cwd: '/tmp' })).toEqual({ deployed: false });
  });
});

// Mock do _providers.tf.json — o synth só declara as variáveis que o projeto
// usa; o deploy passa `-var` apenas dessas (terraform erra em var não-declarada).
function mockProviders(vars: Record<string, unknown>) {
  mockedFs.readFileSync.mockImplementation((p: any) =>
    String(p).endsWith('_providers.tf.json') ? JSON.stringify({ variable: vars }) : '',
  );
}

describe('gcpExecutor.planDeploy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.existsSync.mockReturnValue(true);
    // Sem sidecars .iacmp-meta.json no diretório — collectAllFunctionMeta
    // (build de handlers) não acha nenhuma Fn.Lambda pra empacotar.
    mockedFs.readdirSync.mockReturnValue([] as any);
    mockProviders({ project_id: {}, gcp_region: {} });
  });

  test('monta terraform init + apply com project_id e region', async () => {
    const ctx: DeployContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      templatePath: '/tmp/x.tf.json',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].bin).toBe('terraform');
    expect(commands[0].args).toContain('init');
    expect(commands[1].bin).toBe('terraform');
    expect(commands[1].args).toContain('apply');
    expect(commands[1].args.join(' ')).toContain('project_id=meu-projeto');
    expect(commands[1].args.join(' ')).toContain('gcp_region=us-central1');
    // Sem construct zonal declarado → gcp_zone NÃO é passado (senão o terraform
    // erra "Value for undeclared variable").
    expect(commands[1].args.join(' ')).not.toContain('gcp_zone');
  });

  test('passa -var=gcp_zone só quando o synth declara a variável (construct zonal)', async () => {
    mockProviders({ project_id: {}, gcp_region: {}, gcp_zone: {} });
    const ctx: DeployContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      templatePath: '/tmp/x.tf.json',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands[1].args.join(' ')).toContain('gcp_zone=us-central1-a');
  });

  test('--dry-run não builda nem sobe handlers (nem lista o diretório de synth)', async () => {
    const ctx: DeployContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      templatePath: '/tmp/x.tf.json',
      region: 'us-central1',
      projectId: 'meu-projeto',
      dryRun: true,
    };

    const commands = await gcpExecutor.planDeploy(ctx);

    expect(commands).toHaveLength(2);
    expect(mockedFs.readdirSync).not.toHaveBeenCalled();
    expect(mockedCp.execFileSync).not.toHaveBeenCalled();
  });

  test('sidecar .iacmp-meta.json com Fn.Lambda cujo handler não é encontrado: build pulado, sem comando de upload', async () => {
    mockedFs.readdirSync.mockReturnValue(['main-stack.iacmp-meta.json'] as any);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('.iacmp-meta.json')) {
        return JSON.stringify({
          functions: [{
            constructId: 'ProcessFn',
            handler: 'dist/process.handler',
            code: 'dist/',
            runtime: 'nodejs20',
            entryPoint: 'handler',
            zipObject: 'processfn.zip',
          }],
        });
      }
      return '';
    });
    // Bucket de artefatos já existe (describe não lança) — só o diretório de
    // synth existe (pra collectAllFunctionMeta prosseguir); nenhum candidato
    // de source do handler é achado (força "Handler não encontrado").
    mockedFs.existsSync.mockImplementation((p: any) => String(p).includes('synth-out'));
    mockedCp.execFileSync.mockReturnValue('' as any);

    const ctx: DeployContext = {
      cwd: '/tmp/proj',
      stackName: 'main-stack',
      templatePath: '/tmp/proj/synth-out/gcp/main-stack.tf.json',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDeploy(ctx);

    // Só terraform init+apply — nenhum "gcloud storage cp" (handler não achado).
    expect(commands).toHaveLength(2);
    expect(commands.some(c => c.bin === 'gcloud')).toBe(false);
  });
});

// Bug real de deploy GCP: código do handler muda, infra não — o object do
// zip no bucket tinha nome FIXO (`<id>.zip`), então o Terraform nunca via
// diff no `storage_source.object` e a Cloud Function ficava presa no código
// antigo (só destroy+recreate pegava o novo). Fix: versionar o object pelo
// hash do bundle e reescrever o tf.json com o nome versionado antes do apply.
describe('hashFunctionBundle', () => {
  beforeEach(() => jest.resetAllMocks());

  test('é determinístico: mesmo conteúdo de handler.js/index.js/package.json produz o mesmo hash', () => {
    const files: Record<string, string> = {
      'handler.js': 'console.log("v1");',
      'index.js': 'require("./handler.js");',
      'package.json': '{"main":"index.js"}',
    };
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const name = String(p).split('/').pop()!;
      return files[name] as any;
    });

    const hash1 = hashFunctionBundle('/tmp/build/Fn');
    const hash2 = hashFunctionBundle('/tmp/build/Fn');

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{10}$/);
  });

  test('conteúdo diferente (handler mudou) produz hash diferente', () => {
    const filesV1: Record<string, string> = {
      'handler.js': 'console.log("v1");',
      'index.js': 'require("./handler.js");',
      'package.json': '{"main":"index.js"}',
    };
    const filesV2: Record<string, string> = { ...filesV1, 'handler.js': 'console.log("v2 — mudou o handler");' };

    mockedFs.readFileSync.mockImplementation((p: any) => filesV1[String(p).split('/').pop()!] as any);
    const hashV1 = hashFunctionBundle('/tmp/build/Fn');

    mockedFs.readFileSync.mockImplementation((p: any) => filesV2[String(p).split('/').pop()!] as any);
    const hashV2 = hashFunctionBundle('/tmp/build/Fn');

    expect(hashV1).not.toBe(hashV2);
  });
});

describe('versionedZipObject', () => {
  test('acrescenta o hash antes da extensão .zip, mantendo o id legível', () => {
    expect(versionedZipObject('processfn.zip', 'abc1234567')).toBe('processfn-abc1234567.zip');
  });
});

describe('patchFunctionZipObjects', () => {
  beforeEach(() => jest.resetAllMocks());

  function makeFn(constructId: string, zipObject: string): GCPFunctionMeta {
    return { constructId, handler: 'dist/process.handler', code: 'dist/', runtime: 'nodejs20', entryPoint: 'handler', zipObject, trigger: 'http' };
  }

  test('reescreve storage_source.object para o nome versionado, localizando o resource pelo tfId', () => {
    const tfJson = {
      resource: {
        google_cloudfunctions2_function: {
          processfn: {
            name: 'ProcessFn',
            build_config: [{ source: [{ storage_source: [{ bucket: '${var.project_id}-artifacts', object: 'processfn.zip' }] }] }],
          },
        },
      },
    };
    mockedFs.readdirSync.mockReturnValue(['main-stack.tf.json'] as any);
    mockedFs.readFileSync.mockImplementation(() => JSON.stringify(tfJson) as any);
    let written: string | undefined;
    mockedFs.writeFileSync.mockImplementation((_p: any, content: any) => { written = String(content); });

    patchFunctionZipObjects('/tmp/proj/synth-out/gcp', [makeFn('ProcessFn', 'processfn-abc1234567.zip')]);

    expect(written).toBeDefined();
    const patched = JSON.parse(written!);
    expect(patched.resource.google_cloudfunctions2_function.processfn.build_config[0].source[0].storage_source[0].object)
      .toBe('processfn-abc1234567.zip');
  });

  test('não reescreve (nem chama writeFileSync) quando o object já está atualizado (idempotência — sem apply à toa)', () => {
    const tfJson = {
      resource: {
        google_cloudfunctions2_function: {
          processfn: {
            build_config: [{ source: [{ storage_source: [{ object: 'processfn-abc1234567.zip' }] }] }],
          },
        },
      },
    };
    mockedFs.readdirSync.mockReturnValue(['main-stack.tf.json'] as any);
    mockedFs.readFileSync.mockImplementation(() => JSON.stringify(tfJson) as any);

    patchFunctionZipObjects('/tmp/proj/synth-out/gcp', [makeFn('ProcessFn', 'processfn-abc1234567.zip')]);

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  test('ignora arquivos que não são tf.json e stacks sem Cloud Function', () => {
    mockedFs.readdirSync.mockReturnValue(['_providers.tf.json', 'main-stack.iacmp-meta.json'] as any);
    mockedFs.readFileSync.mockImplementation(() => JSON.stringify({ resource: {} }) as any);

    expect(() => patchFunctionZipObjects('/tmp/proj/synth-out/gcp', [makeFn('ProcessFn', 'processfn-abc1234567.zip')])).not.toThrow();
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  test('não toca o filesystem quando não há functions builded (lista vazia)', () => {
    patchFunctionZipObjects('/tmp/proj/synth-out/gcp', []);
    expect(mockedFs.readdirSync).not.toHaveBeenCalled();
  });
});

// Carrega o código gerado por renderGcpFunctionWrapper isoladamente via `vm`
// (sem tocar fs/esbuild reais nem o mock global de `fs`) — injeta um
// `require('./handler.js')` fake que devolve o módulo de handler do usuário
// controlado pelo teste, e executa a fonte real do adapter num sandbox.
function loadWrapper(source: string, handlerModule: Record<string, unknown>): Record<string, (req: unknown, res: unknown) => unknown> {
  const sandboxModule = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (p: string) => {
      if (p === './handler.js') return handlerModule;
      throw new Error(`require inesperado no sandbox: ${p}`);
    },
    Buffer,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandboxModule.exports as Record<string, (req: unknown, res: unknown) => unknown>;
}

describe('renderGcpFunctionWrapper', () => {
  test('handler formato Lambda (arity 1) é envolvido: monta o event e converte a resposta', async () => {
    const lambdaHandler = jest.fn(async (event: Record<string, unknown>) => ({
      statusCode: 201,
      headers: { 'X-Test': 'sim' },
      body: JSON.stringify({ method: event.httpMethod, path: event.path, pathParameters: event.pathParameters, query: event.queryStringParameters, body: event.body }),
    }));
    const wrapped = loadWrapper(renderGcpFunctionWrapper('handler'), { handler: lambdaHandler });

    const req = {
      method: 'POST',
      path: '/items/42',
      query: { verbose: '1' },
      headers: { 'content-type': 'application/json' },
      body: { foo: 'bar' },
    };
    const res = { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), send: jest.fn() };

    await wrapped.handler(req, res);

    expect(lambdaHandler).toHaveBeenCalledTimes(1);
    const event = lambdaHandler.mock.calls[0][0];
    expect(event.httpMethod).toBe('POST');
    expect(event.path).toBe('/items/42');
    // heurística "último segmento = id" — mesma do adapter Azure
    expect(event.pathParameters).toEqual({ id: '42', proxy: '42' });
    expect(event.queryStringParameters).toEqual({ verbose: '1' });
    expect(JSON.parse(event.body as string)).toEqual({ foo: 'bar' });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.set).toHaveBeenCalledWith('X-Test', 'sim');
    const sent = JSON.parse((res.send as jest.Mock).mock.calls[0][0]);
    expect(sent).toEqual({ method: 'POST', path: '/items/42', pathParameters: { id: '42', proxy: '42' }, query: { verbose: '1' }, body: JSON.stringify({ foo: 'bar' }) });
  });

  test('handler formato Lambda que lança exceção vira resposta 500', async () => {
    const lambdaHandler = jest.fn(async () => { throw new Error('boom'); });
    const wrapped = loadWrapper(renderGcpFunctionWrapper('handler'), { handler: lambdaHandler });
    const req = { method: 'GET', path: '/', query: {}, headers: {} };
    const res = { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), send: jest.fn() };

    await wrapped.handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.parse((res.send as jest.Mock).mock.calls[0][0]).error).toContain('boom');
  });

  test('handler nativo (req,res) (arity >= 2) é chamado direto, sem montar event', async () => {
    const nativeHandler = jest.fn((_req: unknown, res: { status: (n: number) => { send: (b: string) => void } }) => {
      res.status(200).send('native-ok');
    });
    const wrapped = loadWrapper(renderGcpFunctionWrapper('handler'), { handler: nativeHandler });
    const req = { method: 'GET', path: '/', query: {}, headers: {} };
    const res = { status: jest.fn().mockReturnValue({ send: jest.fn() }) };

    await wrapped.handler(req, res);

    expect(nativeHandler).toHaveBeenCalledWith(req, res);
  });

  test('respeita entryPoint diferente de "handler" (nome exportado calculado pelo synth)', async () => {
    const lambdaHandler = jest.fn(async () => ({ statusCode: 200, body: 'ok' }));
    const wrapped = loadWrapper(renderGcpFunctionWrapper('processItem'), { processItem: lambdaHandler });
    const req = { method: 'GET', path: '/x', query: {}, headers: {} };
    const res = { status: jest.fn().mockReturnThis(), set: jest.fn().mockReturnThis(), send: jest.fn() };

    await wrapped.processItem(req, res);

    expect(lambdaHandler).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// Carrega o código gerado por renderGcpEventWrapper isoladamente via `vm` —
// injeta um `require('./handler.js')` fake (módulo do usuário) e um
// `require('@google-cloud/functions-framework')` fake que grava o que foi
// registrado via `functions.cloudEvent(name, fn)`, sem tocar fs/rede reais.
function loadEventWrapper(source: string, handlerModule: Record<string, unknown>): {
  registered: Record<string, (...args: unknown[]) => any>;
} {
  const registered: Record<string, (...args: unknown[]) => any> = {};
  const sandboxModule = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: (p: string) => {
      if (p === './handler.js') return handlerModule;
      if (p === '@google-cloud/functions-framework') {
        return { cloudEvent: (name: string, fn: (...args: unknown[]) => unknown) => { registered[name] = fn; } };
      }
      throw new Error(`require inesperado no sandbox: ${p}`);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { registered };
}

describe('renderGcpEventWrapper', () => {
  test('registra o handler via functions.cloudEvent (não functions.http) e repassa o CloudEvent DIRETO, sem montar event HTTP-Lambda', async () => {
    // Handler típico de worker Pub/Sub: espera o CloudEvent cru, lê
    // event.data.message.data (payload base64). Se o adapter errado (HTTP)
    // fosse usado, esse campo chegaria vazio — exatamente o bug reportado
    // em deploy real ("job processado: {}").
    const pubsubHandler = jest.fn(async (event: any) => {
      return { received: event.data.message.data };
    });
    const { registered } = loadEventWrapper(renderGcpEventWrapper('handler'), { handler: pubsubHandler });

    expect(Object.keys(registered)).toEqual(['handler']);

    const cloudEvent = {
      id: 'abc-123',
      source: '//pubsub.googleapis.com/projects/p/topics/jobs',
      type: 'google.cloud.pubsub.topic.v1.messagePublished',
      data: { message: { data: Buffer.from(JSON.stringify({ jobId: 42 })).toString('base64') } },
    };

    const result = await registered.handler(cloudEvent);

    // O handler recebeu o CloudEvent tal como veio — nenhum campo HTTP
    // (httpMethod/path/pathParameters/headers) foi injetado por cima.
    expect(pubsubHandler).toHaveBeenCalledWith(cloudEvent);
    expect(pubsubHandler.mock.calls[0][0].httpMethod).toBeUndefined();
    expect(result.received).toBe(cloudEvent.data.message.data);
  });

  test('respeita entryPoint diferente de "handler" no registro do functions.cloudEvent', () => {
    const pubsubHandler = jest.fn();
    const { registered } = loadEventWrapper(renderGcpEventWrapper('processJob'), { processJob: pubsubHandler });
    expect(Object.keys(registered)).toEqual(['processJob']);
  });

  test('entry point ausente em handler.js lança erro claro', () => {
    expect(() => loadEventWrapper(renderGcpEventWrapper('handler'), {})).toThrow(/GCP entry point "handler" não encontrado/);
  });
});

describe('planDeploy — import do Firestore (default) preexistente (idempotência)', () => {
  const ctx = { cwd: '/tmp', stackName: 's', templatePath: '/tmp/x.tf.json', region: 'us-central1', projectId: 'meu-projeto' } as DeployContext;

  beforeEach(() => {
    jest.resetAllMocks();
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([] as any);
  });

  // _providers com o singleton Firestore declarado; tfstate ausente (primeiro apply).
  function mockSynthWithFirestore() {
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('_providers.tf.json'))
        return JSON.stringify({ variable: { project_id: {}, gcp_region: {} }, resource: { google_firestore_database: { iacmp_default: {} } } }) as any;
      throw new Error('ENOENT'); // sem terraform.tfstate
    });
  }

  test('insere `terraform import` (antes do apply) quando o db (default) já existe na nuvem e não está no state', async () => {
    mockSynthWithFirestore();
    mockedCp.execFileSync.mockReturnValue('' as any); // gcloud firestore describe → sucesso (db existe)

    const commands = await gcpExecutor.planDeploy(ctx);
    const importCmd = commands.find((c) => (c.args as string[]).includes('import'));
    expect(importCmd).toBeDefined();
    expect((importCmd!.args as string[]).join(' ')).toContain('google_firestore_database.iacmp_default');
    expect((importCmd!.args as string[]).join(' ')).toContain('projects/meu-projeto/databases/(default)');
    const idxImport = commands.findIndex((c) => (c.args as string[]).includes('import'));
    const idxApply = commands.findIndex((c) => (c.args as string[]).includes('apply'));
    expect(idxImport).toBeGreaterThan(0); // depois do init
    expect(idxImport).toBeLessThan(idxApply); // antes do apply
  });

  test('NÃO importa quando o db (default) ainda não existe na nuvem (describe falha)', async () => {
    mockSynthWithFirestore();
    mockedCp.execFileSync.mockImplementation((_b: any, args: any) => {
      if ((args as string[]).join(' ').includes('firestore')) throw new Error('NOT_FOUND');
      return '' as any;
    });

    const commands = await gcpExecutor.planDeploy(ctx);
    expect(commands.some((c) => (c.args as string[]).includes('import'))).toBe(false);
  });
});

describe('gcpExecutor.planDestroy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockProviders({ project_id: {}, gcp_region: {} });
  });

  test('monta terraform init + destroy com project_id', async () => {
    const ctx: DestroyContext = {
      cwd: '/tmp',
      stackName: 'main-stack',
      region: 'us-central1',
      projectId: 'meu-projeto',
    };

    const commands = await gcpExecutor.planDestroy(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0].args).toContain('init');
    expect(commands[1].args).toContain('destroy');
    expect(commands[1].args.join(' ')).toContain('project_id=meu-projeto');
  });
});
