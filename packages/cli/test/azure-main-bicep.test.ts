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
