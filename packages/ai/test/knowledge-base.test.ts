import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Semeia um banco igual ao do iacmp-mcp (examples + examples_fts) para provar
// que o retrieval do packages/ai casa com o do MCP: FTS5 + boost de validated,
// com fallback ao BM25 legado quando o índice FTS não existe.

function ftsBody(ex: { title: string; tags: string[]; constructs: string[]; notes: string[]; stacks: Record<string, string>; handlers: Record<string, string> }): string {
  return [ex.title, ...ex.tags, ...ex.constructs, ...ex.notes, ...Object.values(ex.stacks), ...Object.values(ex.handlers)].join('\n');
}

function seed(dbPath: string, withFts: boolean): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE examples (id TEXT PRIMARY KEY, title TEXT, provider TEXT, constructs TEXT, tags TEXT, content TEXT, tokens TEXT, validated INTEGER);
    ${withFts ? "CREATE VIRTUAL TABLE examples_fts USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');" : ''}
  `);
  const rows = [
    { id: 'twin-gen', validated: 0, title: 'DynamoDB CRUD', tags: ['aws', 'dynamodb'], constructs: ['Database.DynamoDB'], notes: ['crud simples'], stacks: { 's.ts': 'new Database.DynamoDB()' }, handlers: {} },
    { id: 'twin-val', validated: 1, title: 'DynamoDB CRUD', tags: ['aws', 'dynamodb'], constructs: ['Database.DynamoDB'], notes: ['crud simples'], stacks: { 's.ts': 'new Database.DynamoDB()' }, handlers: {} },
    { id: 'cosmos', validated: 0, title: 'Cosmos Table', tags: ['aws', 'cosmos'], constructs: ['Database.DynamoDB'], notes: ['getEntity flat'], stacks: { 's.ts': 'cosmos' }, handlers: {} },
  ];
  const insE = db.prepare('INSERT INTO examples (id,title,provider,constructs,tags,content,tokens,validated) VALUES (?,?,?,?,?,?,?,?)');
  const insF = withFts ? db.prepare('INSERT INTO examples_fts (id, body) VALUES (?, ?)') : null;
  for (const r of rows) {
    const content = { stacks: r.stacks, handlers: r.handlers, notes: r.notes };
    const tokens = [r.title, ...r.tags, ...r.constructs, ...r.notes].join(' ').toLowerCase().split(/\W+/).filter(Boolean);
    insE.run(r.id, r.title, 'aws', JSON.stringify(r.constructs), JSON.stringify(r.tags), JSON.stringify(content), JSON.stringify(tokens), r.validated);
    if (insF) insF.run(r.id, ftsBody(r));
  }
  db.close();
}

function withDb(withFts: boolean, fn: (search: (q: string, p: string, l?: number) => string) => void): void {
  const tmp = path.join(os.tmpdir(), `iacmp-kb-test-${process.pid}-${withFts ? 'fts' : 'legacy'}.db`);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* noop */ } }
  seed(tmp, withFts);
  const prev = process.env.IACMP_MCP_DB;
  process.env.IACMP_MCP_DB = tmp;
  jest.resetModules();
  try {
    // require após setar a env — DB_PATH é lido no load do módulo
    const { searchKnowledgeBase } = require('../src/rag/knowledge-base') as typeof import('../src/rag/knowledge-base');
    fn(searchKnowledgeBase);
  } finally {
    if (prev === undefined) delete process.env.IACMP_MCP_DB; else process.env.IACMP_MCP_DB = prev;
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* noop */ } }
  }
}

describe('searchKnowledgeBase — paridade FTS5 com o MCP', () => {
  test('usa FTS quando disponível: validado vence o empate (boost)', () => {
    withDb(true, (search) => {
      const out = search('dynamodb crud', 'aws', 3);
      expect(out).toContain('DynamoDB CRUD');
      // o twin validado (✓) deve aparecer antes do gerado (○)
      expect(out.indexOf('✓ DynamoDB CRUD')).toBeGreaterThanOrEqual(0);
      expect(out.indexOf('✓ DynamoDB CRUD')).toBeLessThan(out.indexOf('○ DynamoDB CRUD'));
    });
  });

  test('exemplo não-validado é retornado (sem gate de visibilidade)', () => {
    withDb(true, (search) => {
      const out = search('cosmos table', 'aws', 3);
      expect(out).toContain('Cosmos Table');
      expect(out).toContain('○'); // marcado como gerado
    });
  });

  test('constrói o FTS se faltar (usuário só-CLI, sem MCP): boost passa a valer', () => {
    withDb(false, (search) => {
      const out = search('dynamodb crud', 'aws', 3);
      expect(out).toContain('DynamoDB CRUD');
      // ensureFts populou o índice → o boost do validado já ordena
      expect(out.indexOf('✓ DynamoDB CRUD')).toBeLessThan(out.indexOf('○ DynamoDB CRUD'));
    });
  });

  test('banco read-only sem FTS: fallback ao BM25 legado, sem quebrar', () => {
    const tmp = path.join(os.tmpdir(), `iacmp-kb-ro-${process.pid}.db`);
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* noop */ } }
    seed(tmp, false);
    fs.chmodSync(tmp, 0o444); // força read-only → ensureFts falha silenciosa
    const prev = process.env.IACMP_MCP_DB;
    process.env.IACMP_MCP_DB = tmp;
    jest.resetModules();
    try {
      const { searchKnowledgeBase } = require('../src/rag/knowledge-base') as typeof import('../src/rag/knowledge-base');
      const out = searchKnowledgeBase('dynamodb crud', 'aws', 3);
      expect(out).toContain('DynamoDB CRUD'); // legado ainda entrega
    } finally {
      if (prev === undefined) delete process.env.IACMP_MCP_DB; else process.env.IACMP_MCP_DB = prev;
      try { fs.chmodSync(tmp, 0o644); } catch { /* noop */ }
      for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* noop */ } }
    }
  });
});
