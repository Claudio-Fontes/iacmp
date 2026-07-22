import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateAzureMainBicep, orderByDependency, TemplateRef } from '../src/synth-out';

describe('generateAzureMainBicep — deployment único com módulos', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-main-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeBicep(fileName: string, lines: string[]): TemplateRef {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, lines.join('\n'));
    return { stackName: fileName.replace(/\.bicep$/, ''), filePath, fileName };
  }

  test('param hard vira referência simbólica ao output do módulo anterior', () => {
    const db = writeBicep('database-stack.bicep', [
      "param location string = resourceGroup().location",
      "output ItemsTableName string = itemsTable.name",
      "output ItemsTableConnectionString string = 'cs'",
    ]);
    const api = writeBicep('api-stack.bicep', [
      "param location string = resourceGroup().location",
      'param ItemsTableName string',
      'param ItemsTableConnectionString string',
      "output apiUrl string = 'url'",
    ]);

    const main = generateAzureMainBicep(orderByDependency([api, db]));

    // módulo db antes do api; api recebe refs simbólicas
    expect(main.indexOf("module stk_database_stack 'database-stack.bicep'"))
      .toBeLessThan(main.indexOf("module stk_api_stack 'api-stack.bicep'"));
    expect(main).toContain('ItemsTableName: stk_database_stack.outputs.ItemsTableName');
    expect(main).toContain('ItemsTableConnectionString: stk_database_stack.outputs.ItemsTableConnectionString');
    // outputs re-exportados (zip deploy e 2º passo leem da stack única)
    expect(main).toContain('output ItemsTableName string = stk_database_stack.outputs.ItemsTableName');
    expect(main).toContain('output apiUrl string = stk_api_stack.outputs.apiUrl');
  });

  test('param soft COM exportador anterior também vira referência simbólica (bug 589e4b4 impossível)', () => {
    const db = writeBicep('db.bicep', [
      "output FlagsTableConnectionString string = 'cs'",
    ]);
    const compute = writeBicep('compute.bicep', [
      "param FlagsTableConnectionString string = ''",
    ]);
    const main = generateAzureMainBicep(orderByDependency([compute, db]));
    expect(main).toContain('FlagsTableConnectionString: stk_db.outputs.FlagsTableConnectionString');
    // NÃO vira param de 2º passo — resolve direto no grafo
    expect(main).not.toMatch(/^param FlagsTableConnectionString/m);
  });

  test('senha: params *password amarram no adminPassword @secure do main', () => {
    const db = writeBicep('db.bicep', [
      'param adminPassword string',
      "output AppDBEndpoint string = 'ep'",
    ]);
    const api = writeBicep('api.bicep', [
      'param AppDBEndpoint string',
      'param AppDBPassword string',
    ]);
    const main = generateAzureMainBicep(orderByDependency([api, db]));
    expect(main).toMatch(/@secure\(\)\nparam adminPassword string/);
    expect(main).toContain('adminPassword: adminPassword');
    expect(main).toContain('AppDBPassword: adminPassword');
  });

  test('ciclo real (Event Grid): soft param cujo exportador vem DEPOIS vira param de 2º passo', () => {
    // storage precisa do FQDN da function (que só existe pós-deploy); a function
    // importa o nome do bucket (hard) — então storage deploya primeiro.
    const storage = writeBicep('storage.bicep', [
      "param dataProcessorFnFqdn string = ''",
      "output RawBucketName string = 'raw'",
    ]);
    const fn = writeBicep('function.bicep', [
      'param RawBucketName string',
      "output dataProcessorFnFqdn string = 'fqdn'",
    ]);
    const main = generateAzureMainBicep(orderByDependency([fn, storage]));
    expect(main).toMatch(/^param dataProcessorFnFqdn string = ''$/m);
    expect(main).toContain('dataProcessorFnFqdn: dataProcessorFnFqdn');
  });

  test('sharedCaeId NUNCA vira param de 2º passo (auto-injeção deletaria o CAE)', () => {
    const a = writeBicep('containers-a.bicep', [
      "param sharedCaeId string = ''",
      'output sharedCaeId string = cae.id',
    ]);
    const b = writeBicep('containers-b.bicep', [
      "param sharedCaeId string = ''",
      'output sharedCaeId string = cae.id',
    ]);
    const main = generateAzureMainBicep([a, b]);
    // a (primeiro) fica com default '' → cria o CAE; b recebe simbólico de a
    expect(main).not.toMatch(/^param sharedCaeId/m);
    expect(main).toContain('sharedCaeId: stk_containers_a.outputs.sharedCaeId');
  });

  test('param hard sem exportador → erro de synth com orientação', () => {
    const api = writeBicep('api.bicep', ['param GhostTableName string']);
    expect(() => generateAzureMainBicep([api])).toThrow(/GhostTableName/);
    expect(() => generateAzureMainBicep([api])).toThrow(/nenhuma stack anterior exporta/);
  });

  test('soft param sem exportador em lugar nenhum (ex: location) mantém o default do módulo', () => {
    const a = writeBicep('a.bicep', [
      "param location string = resourceGroup().location",
      "output X string = 'x'",
    ]);
    const main = generateAzureMainBicep([a]);
    expect(main).not.toContain('location:');
    expect(main).not.toMatch(/^param location/m);
  });

  test('output duplicado entre módulos: o último vence (semântica do acumulador)', () => {
    const a = writeBicep('a.bicep', ["output Endpoint string = 'a'"]);
    const b = writeBicep('b.bicep', ["output Endpoint string = 'b'"]);
    const main = generateAzureMainBicep([a, b]);
    const matches = main.match(/^output Endpoint /gm) ?? [];
    expect(matches.length).toBe(1);
    expect(main).toContain('output Endpoint string = stk_b.outputs.Endpoint');
  });

  test('módulo sem params amarrados sai sem bloco params', () => {
    const a = writeBicep('a.bicep', ["output X string = 'x'"]);
    const main = generateAzureMainBicep([a]);
    expect(main).toContain("module stk_a 'a.bicep' = {");
    expect(main).toContain("  name: 'a'");
    expect(main).not.toContain('params:');
  });
});

// Bug real de bateria (p07 e p09): o ARM rejeitava `--parameters acrServer=...` com
// "unrecognized template parameter" porque acrServer/acrUser/acrPassword/<id>Image
// só existiam DENTRO do módulo compute-stack.bicep (com default), nunca hoisted pro
// top-level do _main.bicep — o deploy só injeta esses --parameters quando o projeto
// tem `Compute.Container` com `build` (sidecar `containerBuilds` não-vazio).
describe('generateAzureMainBicep — pipeline de build de imagem (acrServer/acrUser/acrPassword/<id>Image)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-main-build-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeBicep(fileName: string, lines: string[]): TemplateRef {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, lines.join('\n'));
    return { stackName: fileName.replace(/\.bicep$/, ''), filePath, fileName };
  }

  test('com containerBuilds: acrServer/acrUser/acrPassword(@secure)/<id>Image viram params top-level e são repassados ao módulo que os declara', () => {
    const compute = writeBicep('compute-stack.bicep', [
      "param location string = resourceGroup().location",
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param appImage string = 'node:20-alpine'",
      "output AppContainerFqdn string = app.properties.configuration.ingress.fqdn",
    ]);

    const main = generateAzureMainBicep(orderByDependency([compute]), ['appImage']);

    // Params top-level declarados
    expect(main).toMatch(/^param acrServer string = ''$/m);
    expect(main).toMatch(/^param acrUser string = ''$/m);
    expect(main).toMatch(/@secure\(\)\nparam acrPassword string = ''/);
    expect(main).toMatch(/^param appImage string = 'node:20-alpine'$/m);

    // Repasse por passthrough direto no módulo (nunca via output — o valor vem do deploy)
    expect(main).toContain('acrServer: acrServer');
    expect(main).toContain('acrUser: acrUser');
    expect(main).toContain('acrPassword: acrPassword');
    expect(main).toContain('appImage: appImage');
  });

  test('sem containerBuilds (array vazio/omitido): nenhum param extra é declarado nem repassado — comportamento idêntico ao pré-existente', () => {
    // Mesmo um módulo que declara acrServer/appImage localmente (Compute.Container SEM
    // build, com image literal) não deve ganhar wiring nem hoist quando o projeto
    // inteiro não tem containerBuilds — o default local do módulo continua valendo.
    const compute = writeBicep('compute-stack.bicep', [
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param appImage string = 'nginx:latest'",
      "output AppContainerFqdn string = app.properties.configuration.ingress.fqdn",
    ]);

    const main = generateAzureMainBicep(orderByDependency([compute]));

    expect(main).not.toMatch(/^param acrServer/m);
    expect(main).not.toMatch(/^param acrUser/m);
    expect(main).not.toMatch(/^param acrPassword/m);
    expect(main).not.toMatch(/^param appImage/m);
    expect(main).not.toContain('acrServer:');
    expect(main).not.toContain('appImage:');
    // Sem bloco de params — o módulo usa seus próprios defaults locais
    expect(main).not.toContain('params:');
  });

  test('só o <id>Image do container COM build é hoisted; container sem build no mesmo projeto mantém o default local', () => {
    const compute = writeBicep('compute-stack.bicep', [
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param appImage string = 'node:20-alpine'",    // tem build
      "param workerImage string = 'redis:7-alpine'", // sem build (image literal)
    ]);

    const main = generateAzureMainBicep(orderByDependency([compute]), ['appImage']);

    expect(main).toMatch(/^param appImage string = 'node:20-alpine'$/m);
    expect(main).not.toMatch(/^param workerImage/m);
    expect(main).toContain('appImage: appImage');
    expect(main).not.toContain('workerImage:'); // sem wiring — usa o default local 'redis:7-alpine'
  });

  test('convive com wiring cross-stack por output (VNet/subnet) no mesmo _main — build não interfere no lift normal (regressão p09)', () => {
    const network = writeBicep('network-stack.bicep', [
      "output AppSubnetSubnetId string = 'subnet-id'",
    ]);
    const compute = writeBicep('compute-stack.bicep', [
      "param AppSubnetSubnetId string = ''", // soft param COM exportador anterior → lift-por-output normal
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param appImage string = 'node:20-alpine'",
    ]);

    const main = generateAzureMainBicep(orderByDependency([compute, network]), ['appImage']);

    // Wiring normal por output — intacto, não veio do fluxo de build
    expect(main).toContain('AppSubnetSubnetId: stk_network_stack.outputs.AppSubnetSubnetId');
    expect(main).not.toMatch(/^param AppSubnetSubnetId/m);
    // Wiring do pipeline de build — intacto, passthrough direto
    expect(main).toContain('acrServer: acrServer');
    expect(main).toContain('appImage: appImage');
    expect(main).toMatch(/^param acrServer string = ''$/m);
  });

  test('acrServer/acrUser/acrPassword são repassados a QUALQUER módulo que os declare, mesmo sem build próprio (container app plano na mesma stack do build)', () => {
    // Simula duas stacks: uma com o Compute.Container que tem build, outra com um
    // Compute.Container comum (image literal) — ambas declaram acrServer/acrUser/
    // acrPassword (emitidos sempre que há QUALQUER Compute.Container na stack).
    const compute1 = writeBicep('compute1-stack.bicep', [
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param appImage string = 'node:20-alpine'",
    ]);
    const compute2 = writeBicep('compute2-stack.bicep', [
      "param acrServer string = ''",
      "param acrUser string = ''",
      "@secure()",
      "param acrPassword string = ''",
      "param workerImage string = 'redis:7-alpine'",
    ]);

    const main = generateAzureMainBicep(orderByDependency([compute1, compute2]), ['appImage']);

    const acrServerWirings = main.match(/acrServer: acrServer/g) ?? [];
    expect(acrServerWirings.length).toBe(2); // as duas stacks recebem o mesmo param compartilhado
    expect(main).toContain('appImage: appImage');
    expect(main).not.toContain('workerImage:'); // não é build — fica no default local
  });
});
