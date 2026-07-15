import { AIGeneratedResponse } from '@iacmp/ai';

// Helper NATIVO do Azure Cosmos DB Table API. É injetado como `src/tables.ts`
// em todo projeto Azure que usa Database.DynamoDB. Dá aos handlers uma API
// simples (get/put/update/increment/del/list) — a mesma ergonomia que o
// DynamoDBDocumentClient dá no AWS — resolvendo num ÚNICO lugar testado as 3
// armadilhas do @azure/data-tables que o modelo erra a cada geração:
//   1. getEntity() retorna a entidade FLAT (não tem .value)
//   2. getEntity() LANÇA RestError 404 quando não existe (não retorna null)
//   3. o objeto retornado carrega campos OData (odata.*/etag/timestamp) que,
//      se regravados, dão 400 PropertyNameInvalid
// É 100% Azure (@azure/data-tables por baixo) — nenhum @aws-sdk, nenhum shim.
export const AZURE_TABLES_HELPER = `// GERADO pelo iacmp — NÃO editar. Helper nativo do Azure Cosmos DB Table API.
// API simples por cima do @azure/data-tables: get/put/update/increment/del/list.
import { TableClient, odata } from '@azure/data-tables';

// any (não unknown) para os VALORES: o handler acessa item.email/item.slug como
// string sem cast — mesma ergonomia do DynamoDBDocumentClient no AWS. unknown
// forçava casts que o modelo esquece → erro de TS que travava a geração.
type Item = Record<string, any>;

function client(): TableClient {
  const conn = process.env.COSMOS_CONNECTION;
  const name = process.env.TABLE_NAME;
  if (!conn) throw new Error('COSMOS_CONNECTION não definida no ambiente da Function');
  if (!name) throw new Error('TABLE_NAME não definida no ambiente da Function');
  return TableClient.fromConnectionString(conn, name);
}

// Entidade -> item de negócio: expõe rowKey como \\\`id\\\`, remove OData/metadados.
function toItem(e: Record<string, unknown>): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'partitionKey' || k === 'etag' || k === 'timestamp') continue;
    if (k.indexOf('odata.') === 0) continue;
    if (k === 'rowKey') { out.id = v; continue; }
    out[k] = v;
  }
  return out;
}

// Só campos de negócio para gravar (nunca id/partition/rowKey/OData/undefined).
function fields(o: Item): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (k === 'id' || k === 'partitionKey' || k === 'rowKey' || k === 'etag' || k === 'timestamp') continue;
    if (k.indexOf('odata.') === 0) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}

export function table(partition = 'items') {
  const c = client();
  return {
    // Item (com \\\`id\\\`) ou null se não existir — NUNCA lança 404.
    async get(id: string): Promise<Item | null> {
      try {
        const e = await c.getEntity(partition, String(id));
        return toItem(e as Record<string, unknown>);
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
    // Cria/sobrescreve. ifNotExists:true → retorna false se já existir (não sobrescreve).
    async put(id: string, item: Item, opts?: { ifNotExists?: boolean }): Promise<boolean> {
      const entity = { partitionKey: partition, rowKey: String(id), ...fields(item) };
      if (opts && opts.ifNotExists) {
        try { await c.createEntity(entity); return true; }
        catch (err) { if (statusOf(err) === 409) return false; throw err; }
      }
      await c.upsertEntity(entity, 'Replace');
      return true;
    },
    // Mescla os campos informados no item existente (Merge — preserva os demais).
    async update(id: string, patch: Item): Promise<void> {
      await c.updateEntity({ partitionKey: partition, rowKey: String(id), ...fields(patch) }, 'Merge');
    },
    // Incrementa um campo numérico (read-modify-write). Cria o item se não existir.
    async increment(id: string, field: string, by = 1, seed: Item = {}): Promise<number> {
      const cur = await this.get(id);
      const next = Number((cur ? cur[field] : undefined) ?? 0) + by;
      const base = cur ? fields(cur) : fields(seed);
      await c.upsertEntity({ partitionKey: partition, rowKey: String(id), ...base, [field]: next }, 'Merge');
      return next;
    },
    async del(id: string): Promise<void> {
      try { await c.deleteEntity(partition, String(id)); }
      catch (err) { if (statusOf(err) !== 404) throw err; }
    },
    // Todos os itens da partição.
    async list(): Promise<Item[]> {
      const out: Item[] = [];
      for await (const e of c.listEntities()) out.push(toItem(e as Record<string, unknown>));
      return out;
    },
    // Itens cujo id (rowKey) começa com o prefixo (ex: 'dev#', 'page_view#').
    async listByPrefix(prefix: string): Promise<Item[]> {
      const upper = prefix + '\\uffff';
      const out: Item[] = [];
      for await (const e of c.listEntities({ queryOptions: { filter: odata\`RowKey ge \${prefix} and RowKey lt \${upper}\` } })) {
        out.push(toItem(e as Record<string, unknown>));
      }
      return out;
    },
  };
}
`;

// Garante que src/tables.ts (o helper canônico) esteja em parsed.files quando o
// projeto Azure usa Database.DynamoDB. Idempotente e SEMPRE sobrescreve com a
// versão canônica — chamada após cada resposta da IA (inicial e retries) para
// que o reconcile não a remova como órfã e o modelo não a corrompa.
export function ensureAzureTablesHelper(parsed: AIGeneratedResponse, iacProvider: string): void {
  if (iacProvider !== 'azure') return;
  const usesDynamo = parsed.files.some(
    f => f.path.startsWith('stacks/') && /Database\.DynamoDB/.test(f.content),
  );
  if (!usesDynamo) return;
  const entry = { path: 'src/tables.ts', content: AZURE_TABLES_HELPER };
  const idx = parsed.files.findIndex(f => f.path === 'src/tables.ts');
  if (idx >= 0) parsed.files[idx] = entry;
  else parsed.files.push(entry);
}
