import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  templateExt,
  synthRoot,
  providerOutDir,
  resolveTemplateDir,
  listTemplates,
  savedTemplatePath,
  countResources,
} from '../src/synth-out';

/**
 * Regressão do CLI-01: `synth` grava em synth-out/<provider>/ e os comandos
 * consumidores (deploy/destroy/diff/dashboard) precisam ler do MESMO lugar.
 * Estes testes travam o contrato entre o caminho de escrita e o de leitura.
 */

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-synthout-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe('templateExt', () => {
  test('terraform e gcp usam .tf.json, azure usa .bicep, demais usam .json', () => {
    expect(templateExt('terraform')).toBe('.tf.json');
    expect(templateExt('gcp')).toBe('.tf.json');
    expect(templateExt('azure')).toBe('.bicep');
    expect(templateExt('aws')).toBe('.json');
  });
});

describe('caminhos', () => {
  test('synthRoot e providerOutDir', () => {
    expect(synthRoot(cwd)).toBe(path.join(cwd, 'synth-out'));
    expect(providerOutDir(cwd, 'aws')).toBe(path.join(cwd, 'synth-out', 'aws'));
  });
});

describe('resolveTemplateDir', () => {
  test('retorna null quando não há synth-out', () => {
    expect(resolveTemplateDir(cwd, 'aws')).toBeNull();
  });

  test('encontra o subdiretório por provider (layout atual do synth)', () => {
    write(path.join(providerOutDir(cwd, 'aws'), 'net.json'), '{"Resources":{}}');
    expect(resolveTemplateDir(cwd, 'aws')).toBe(providerOutDir(cwd, 'aws'));
  });

  test('cai para o layout legado/flat quando não há subdiretório', () => {
    write(path.join(synthRoot(cwd), 'net.json'), '{"Resources":{}}');
    expect(resolveTemplateDir(cwd, 'aws')).toBe(synthRoot(cwd));
  });

  test('prefere o subdiretório por provider ao flat', () => {
    write(path.join(synthRoot(cwd), 'flat.json'), '{"Resources":{}}');
    write(path.join(providerOutDir(cwd, 'aws'), 'net.json'), '{"Resources":{}}');
    expect(resolveTemplateDir(cwd, 'aws')).toBe(providerOutDir(cwd, 'aws'));
  });
});

describe('listTemplates — contrato escrita/leitura (CLI-01)', () => {
  test('lê o que o synth grava em synth-out/<provider>/', () => {
    // simula o synth: grava no diretório canônico do provider
    write(path.join(providerOutDir(cwd, 'aws'), 'rede.json'), '{"Resources":{"a":{}}}');
    write(path.join(providerOutDir(cwd, 'aws'), 'db.json'), '{"Resources":{"b":{}}}');

    const found = listTemplates(cwd, 'aws').map(t => t.stackName).sort();
    expect(found).toEqual(['db', 'rede']);
  });

  test('isola providers diferentes (sem vazamento entre subdiretórios)', () => {
    write(path.join(providerOutDir(cwd, 'aws'), 'rede.json'), '{"Resources":{}}');
    write(path.join(providerOutDir(cwd, 'terraform'), 'rede.tf.json'), '{"resource":{"x":{"y":{}}}}');

    expect(listTemplates(cwd, 'aws').map(t => t.fileName)).toEqual(['rede.json']);
    expect(listTemplates(cwd, 'terraform').map(t => t.fileName)).toEqual(['rede.tf.json']);
  });

  test('filtra por stack', () => {
    write(path.join(providerOutDir(cwd, 'aws'), 'rede.json'), '{"Resources":{}}');
    write(path.join(providerOutDir(cwd, 'aws'), 'db.json'), '{"Resources":{}}');

    expect(listTemplates(cwd, 'aws', 'db').map(t => t.stackName)).toEqual(['db']);
    expect(listTemplates(cwd, 'aws', 'inexistente')).toEqual([]);
  });

  test('retorna [] quando não há nada', () => {
    expect(listTemplates(cwd, 'aws')).toEqual([]);
  });
});

describe('savedTemplatePath', () => {
  test('resolve o template de uma stack específica', () => {
    write(path.join(providerOutDir(cwd, 'aws'), 'rede.json'), '{"Resources":{}}');
    expect(savedTemplatePath(cwd, 'aws', 'rede')).toBe(
      path.join(providerOutDir(cwd, 'aws'), 'rede.json'),
    );
  });

  test('retorna null para stack inexistente', () => {
    write(path.join(providerOutDir(cwd, 'aws'), 'rede.json'), '{"Resources":{}}');
    expect(savedTemplatePath(cwd, 'aws', 'outra')).toBeNull();
  });
});

describe('countResources', () => {
  test('aws — objeto Resources (CloudFormation)', () => {
    const p = path.join(providerOutDir(cwd, 'aws'), 's.json');
    write(p, JSON.stringify({ Resources: { A: {}, B: {}, C: {} } }));
    expect(countResources(p, 'aws')).toBe(3);
  });

  test('azure — conta declarações resource em Bicep', () => {
    const p = path.join(providerOutDir(cwd, 'azure'), 's.bicep');
    write(p, "resource vnet 'Microsoft.Network/virtualNetworks@2023-04-01' = {}\nresource blob 'Microsoft.Storage/storageAccounts@2023-01-01' = {}\n");
    expect(countResources(p, 'azure')).toBe(2);
  });

  test('gcp — formato .tf.json igual ao terraform', () => {
    const p = path.join(providerOutDir(cwd, 'gcp'), 's.tf.json');
    write(p, JSON.stringify({
      resource: {
        google_compute_network: { main: {} },
        google_storage_bucket: { assets: {} },
      },
    }));
    expect(countResources(p, 'gcp')).toBe(2);
  });

  test('terraform — JSON syntax (.tf.json): conta instâncias de resource', () => {
    const p = path.join(providerOutDir(cwd, 'terraform'), 's.tf.json');
    write(p, JSON.stringify({
      resource: {
        aws_vpc: { main: {} },
        aws_subnet: { a: {}, b: {} },
      },
    }));
    expect(countResources(p, 'terraform')).toBe(3);
  });

  test('arquivo inexistente ou JSON inválido → 0', () => {
    expect(countResources(path.join(cwd, 'nao-existe.json'), 'aws')).toBe(0);
    const bad = path.join(cwd, 'bad.json');
    write(bad, '{ invalido');
    expect(countResources(bad, 'aws')).toBe(0);
  });
});
