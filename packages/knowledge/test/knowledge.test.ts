import Database from 'better-sqlite3';
import { tokenize, buildFtsText, ensureFtsSchema, syncFtsRow, rebuildFts, ftsNeedsRebuild, ftsReady, searchExamples } from '../src/index';

function makeDb(withFts = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE examples (id TEXT PRIMARY KEY, title TEXT, provider TEXT, constructs TEXT, tags TEXT, content TEXT, tokens TEXT, validated INTEGER);`);
  if (withFts) ensureFtsSchema(db);
  return db;
}

function insert(db: Database.Database, id: string, provider: string, validated: number, o: { title: string; tags: string[]; constructs: string[]; notes: string[]; stacks?: Record<string, string>; handlers?: Record<string, string> }): void {
  const content = { stacks: o.stacks ?? {}, handlers: o.handlers ?? {}, notes: o.notes };
  db.prepare('INSERT INTO examples (id,title,provider,constructs,tags,content,tokens,validated) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, o.title, provider, JSON.stringify(o.constructs), JSON.stringify(o.tags), JSON.stringify(content), '[]', validated);
  syncFtsRow(db, id, buildFtsText({ title: o.title, tags: o.tags, constructs: o.constructs, content }));
}

describe('@iacmp/knowledge', () => {
  test('tokenize dobra acentos e ignora tokens de 1 char', () => {
    expect(tokenize('Função Assíncrona')).toEqual(['funcao', 'assincrona']);
    expect(tokenize('a b2 cd')).toEqual(['b2', 'cd']);
  });

  test('buildFtsText inclui o código das stacks/handlers', () => {
    const body = buildFtsText({
      title: 'X', tags: ['aws'], constructs: ['Storage.Bucket'],
      content: { stacks: { 's.ts': 'presignedUrl(bucket)' }, handlers: {}, notes: ['nota'] },
    });
    expect(body).toContain('presignedUrl');
    expect(body).toContain('Storage.Bucket');
    expect(body).toContain('nota');
  });

  test('ftsNeedsRebuild/ftsReady refletem o estado do índice', () => {
    const db = makeDb();
    db.prepare('INSERT INTO examples (id,title,provider,constructs,tags,content,tokens,validated) VALUES (?,?,?,?,?,?,?,?)')
      .run('x', 'T', 'aws', '[]', '[]', '{"stacks":{},"handlers":{},"notes":[]}', '[]', 0);
    expect(ftsNeedsRebuild(db)).toBe(true);
    expect(ftsReady(db)).toBe(false);
    expect(rebuildFts(db)).toBe(1);
    expect(ftsNeedsRebuild(db)).toBe(false);
    expect(ftsReady(db)).toBe(true);
    db.close();
  });

  test('searchExamples: não-validado é buscável e boost desempata o validado', () => {
    const db = makeDb();
    insert(db, 'gen', 'aws', 0, { title: 'DynamoDB CRUD', tags: ['aws', 'dynamodb'], constructs: ['Database.DynamoDB'], notes: ['crud'] });
    insert(db, 'val', 'aws', 1, { title: 'DynamoDB CRUD', tags: ['aws', 'dynamodb'], constructs: ['Database.DynamoDB'], notes: ['crud'] });
    insert(db, 'cosmos', 'azure', 0, { title: 'Cosmos Table', tags: ['azure', 'cosmos'], constructs: ['Database.DynamoDB'], notes: ['flat'] });

    const r = searchExamples(db, 'dynamodb crud', { provider: 'aws', limit: 5 })!;
    const ids = r.map(x => x.id);
    expect(ids).toContain('gen');                       // não-validado aparece
    expect(ids.indexOf('val')).toBeLessThan(ids.indexOf('gen')); // boost desempata
    expect(r.every(x => x.provider === 'aws')).toBe(true);       // filtro provider

    // acento na busca
    const c = searchExamples(db, 'cosmos', { provider: 'azure', limit: 5 })!;
    expect(c.some(x => x.id === 'cosmos')).toBe(true);
    db.close();
  });

  test('searchExamples retorna null quando o FTS não está pronto', () => {
    const db = makeDb(false); // sem índice FTS
    expect(searchExamples(db, 'x', {})).toBeNull();
    db.close();
  });
});
