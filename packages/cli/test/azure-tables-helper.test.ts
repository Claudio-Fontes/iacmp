import { AZURE_TABLES_HELPER, ensureAzureTablesHelper } from '../src/generation/azure-tables-helper';

type Parsed = { files: Array<{ path: string; content: string }> };
const dynamoStack = { path: 'stacks/database/db-stack.ts', content: `new Database.DynamoDB(stack, 'Items', {})` };

describe('ensureAzureTablesHelper — injeção do helper', () => {
  test('azure + Database.DynamoDB → injeta src/tables.ts', () => {
    const p: Parsed = { files: [dynamoStack, { path: 'src/h.ts', content: 'x' }] };
    ensureAzureTablesHelper(p as any, 'azure');
    const helper = p.files.find(f => f.path === 'src/tables.ts');
    expect(helper?.content).toBe(AZURE_TABLES_HELPER);
  });

  test('aws → NÃO injeta (dois mundos separados)', () => {
    const p: Parsed = { files: [dynamoStack] };
    ensureAzureTablesHelper(p as any, 'aws');
    expect(p.files.some(f => f.path === 'src/tables.ts')).toBe(false);
  });

  test('azure sem Database.DynamoDB → NÃO injeta', () => {
    const p: Parsed = { files: [{ path: 'stacks/x.ts', content: 'new Storage.Bucket()' }] };
    ensureAzureTablesHelper(p as any, 'azure');
    expect(p.files.some(f => f.path === 'src/tables.ts')).toBe(false);
  });

  test('idempotente e canônico — sobrescreve um tables.ts corrompido pelo modelo', () => {
    const p: Parsed = { files: [dynamoStack, { path: 'src/tables.ts', content: '// lixo do modelo' }] };
    ensureAzureTablesHelper(p as any, 'azure');
    const helpers = p.files.filter(f => f.path === 'src/tables.ts');
    expect(helpers).toHaveLength(1);
    expect(helpers[0].content).toBe(AZURE_TABLES_HELPER);
  });
});

describe('AZURE_TABLES_HELPER — resolve as 3 armadilhas do @azure/data-tables', () => {
  test('não usa .value (getEntity é flat)', () => {
    expect(AZURE_TABLES_HELPER).not.toMatch(/\.value\b/);
  });
  test('trata 404 do getEntity retornando null', () => {
    expect(AZURE_TABLES_HELPER).toMatch(/statusOf\(err\) === 404\) return null/);
  });
  test('nunca espalha o objeto de resposta — grava só campos de negócio (fields)', () => {
    expect(AZURE_TABLES_HELPER).toMatch(/function fields/);
    expect(AZURE_TABLES_HELPER).toMatch(/odata\./); // filtra campos OData
  });
  test('update usa upsert (cria se não existe) — semântica do UpdateCommand do DynamoDB', () => {
    // updateEntity puro do Azure falha se a entidade não existe; o helper usa
    // upsertEntity('Merge') para o handler poder "gravar resultado" sem pré-criar.
    const updateBody = AZURE_TABLES_HELPER.slice(AZURE_TABLES_HELPER.indexOf('async update('));
    const updateMethod = updateBody.slice(0, updateBody.indexOf('},'));
    expect(updateMethod).toContain("upsertEntity");
    expect(updateMethod).not.toContain("c.updateEntity");
  });

  test('expõe a API simples get/put/update/increment/del/list', () => {
    for (const m of ['async get(', 'async put(', 'async update(', 'async increment(', 'async del(', 'async list(', 'async listByPrefix(']) {
      expect(AZURE_TABLES_HELPER).toContain(m);
    }
  });
  test('é 100% Azure — nenhum @aws-sdk', () => {
    expect(AZURE_TABLES_HELPER).not.toContain('@aws-sdk');
    expect(AZURE_TABLES_HELPER).toContain("from '@azure/data-tables'");
  });

  test('codifica rowKey (# / ? \\ são proibidos no Azure Table) — todos os writes usam encKey', () => {
    // # em chave composta ('page_view#data', 'dev#flag') dá OutOfRangeInput no Azure
    expect(AZURE_TABLES_HELPER).toContain('function encKey');
    expect(AZURE_TABLES_HELPER).toContain('function decKey');
    // get/put/update/increment/del + listByPrefix passam pela codificação
    const encWrites = (AZURE_TABLES_HELPER.match(/rowKey: encKey\(id\)/g) || []).length;
    expect(encWrites).toBeGreaterThanOrEqual(3); // put, update, increment
    expect(AZURE_TABLES_HELPER).toContain('getEntity(partition, encKey(id))');
    expect(AZURE_TABLES_HELPER).toContain('deleteEntity(partition, encKey(id))');
    expect(AZURE_TABLES_HELPER).toContain('encKey(prefix)');
  });

  test('encode/decode é reversível e remove chars proibidos (lógica replicada do helper)', () => {
    const ENC: Record<string, string> = { '~': '~~', '#': '~H', '/': '~S', '?': '~Q', '\\': '~B' };
    const encKey = (id: string) => String(id).replace(/[~#/?\\]/g, c => ENC[c]);
    const decKey = (k: string) => k.replace(/~(.)/g, (_m, c) => (c === '~' ? '~' : c === 'H' ? '#' : c === 'S' ? '/' : c === 'Q' ? '?' : c === 'B' ? '\\' : '~' + c));
    for (const k of ['page_view#2026-07-16', 'dev#flag', 'a/b?c', 'x\\y', 'ja~esc', 'simples']) {
      const e = encKey(k);
      expect(decKey(e)).toBe(k);            // round-trip
      expect(/[#/?\\]/.test(e)).toBe(false); // sem char proibido no rowKey codificado
    }
    // preserva prefixo (listByPrefix funciona): enc(prefix+resto) começa com enc(prefix)
    expect(encKey('dev#flag').startsWith(encKey('dev#'))).toBe(true);
  });
});
