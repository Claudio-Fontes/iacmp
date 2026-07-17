import type { Database } from 'better-sqlite3';

// Fonte ÚNICA do retrieval da knowledge base iacmp. Antes, esta lógica existia
// duplicada em iacmp-mcp/src/db/bm25.ts e packages/ai/rag/knowledge-base.ts, e
// divergia (dois tokenizers, dois corpos de FTS). Agora os dois consomem daqui.
//
// O módulo opera sobre uma conexão better-sqlite3 já aberta (não gerencia path
// nem lifecycle) — cada consumidor abre o seu banco e passa a conexão.

// Boost de relevância normalizada [0,1] dado a exemplos validados em deploy real.
export const VALIDATED_BOOST = 0.15;

// Tokenizer alinhado ao FTS5 'unicode61 remove_diacritics': dobra acentos para
// que "função" case com "funcao". Usado tanto para montar o corpo indexável
// quanto a expressão de busca — os dois lados PRECISAM tokenizar igual.
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length > 1);
}

export interface ExampleContent {
  stacks: Record<string, string>;
  handlers: Record<string, string>;
  notes: string[];
}

// Corpo indexável de um exemplo: metadados + o CÓDIGO das stacks/handlers (não
// só as notes), para que um padrão presente no código seja encontrável.
export function buildFtsText(ex: {
  title: string; tags: string[]; constructs: string[]; content: ExampleContent;
}): string {
  return [
    ex.title,
    ...ex.tags,
    ...ex.constructs,
    ...ex.content.notes,
    ...Object.values(ex.content.stacks),
    ...Object.values(ex.content.handlers),
  ].join('\n');
}

// Cria o índice FTS5 se não existir. Idempotente.
export function ensureFtsSchema(db: Database): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS examples_fts USING fts5(` +
    `id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');`,
  );
}

interface ExampleRowRaw {
  id: string; title: string; provider: string;
  constructs: string; tags: string; content: string;
}

// Sincroniza a linha FTS de um exemplo (delete + insert) — usado no upsert.
export function syncFtsRow(db: Database, id: string, body: string): void {
  db.prepare('DELETE FROM examples_fts WHERE id = ?').run(id);
  db.prepare('INSERT INTO examples_fts (id, body) VALUES (?, ?)').run(id, body);
}

// Reconstrói o índice FTS a partir da tabela examples. Idempotente.
export function rebuildFts(db: Database): number {
  ensureFtsSchema(db);
  const rows = db.prepare('SELECT id, title, provider, constructs, tags, content FROM examples').all() as ExampleRowRaw[];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM examples_fts').run();
    const ins = db.prepare('INSERT INTO examples_fts (id, body) VALUES (?, ?)');
    for (const r of rows) {
      ins.run(r.id, buildFtsText({
        title: r.title,
        tags: JSON.parse(r.tags) as string[],
        constructs: JSON.parse(r.constructs) as string[],
        content: JSON.parse(r.content) as ExampleContent,
      }));
    }
  });
  tx();
  return rows.length;
}

// true se o índice FTS está defasado (menos linhas que examples) — reconstruir.
export function ftsNeedsRebuild(db: Database): boolean {
  try {
    const t = db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='examples_fts'`).get() as { n: number };
    if (t.n === 0) return true;
    const fts = (db.prepare('SELECT count(*) n FROM examples_fts').get() as { n: number }).n;
    const ex = (db.prepare('SELECT count(*) n FROM examples').get() as { n: number }).n;
    return ex > 0 && fts < ex;
  } catch {
    return false;
  }
}

// true se o índice FTS está pronto para busca (presente e não-defasado).
export function ftsReady(db: Database): boolean {
  try {
    const t = db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='examples_fts'`).get() as { n: number };
    if (t.n === 0) return false;
    const fts = (db.prepare('SELECT count(*) n FROM examples_fts').get() as { n: number }).n;
    const ex = (db.prepare('SELECT count(*) n FROM examples').get() as { n: number }).n;
    return fts > 0 && fts >= ex;
  } catch {
    return false;
  }
}

export interface ScoredExample {
  id: string;
  title: string;
  provider: string;
  constructs: string;  // JSON
  tags: string;        // JSON
  content: string;     // JSON
  validated: number;
  score: number;
}

/**
 * Busca via FTS5 (BM25 nativo) + boost normalizado a exemplos validados.
 * Retorna as linhas ordenadas (score desc), ou null se o índice FTS não estiver
 * pronto — nesse caso o chamador decide o fallback.
 *
 * O boost normaliza a relevância dividindo PELO TOPO do conjunto de candidatos
 * (não min-max, que exagera diferenças com poucos candidatos): validatedBoost=
 * 0.15 significa "um validado dentro de 15% da melhor relevância passa à frente".
 */
export function searchExamples(
  db: Database,
  query: string,
  opts: { provider?: string; limit?: number; validatedBoost?: number } = {},
): ScoredExample[] | null {
  if (!ftsReady(db)) return null;
  const { provider, limit = 5, validatedBoost = VALIDATED_BOOST } = opts;

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const matchExpr = qTokens.map(t => `"${t}"`).join(' OR ');

  const rows = db.prepare(`
    SELECT e.id, e.title, e.provider, e.constructs, e.tags, e.content, e.validated,
           bm25(examples_fts) AS rank
    FROM examples_fts
    JOIN examples e ON e.id = examples_fts.id
    WHERE examples_fts MATCH ?
      AND (? IS NULL OR e.provider = ?)
    ORDER BY rank
    LIMIT ?
  `).all(matchExpr, provider ?? null, provider ?? null, limit * 4) as (ScoredExample & { rank: number })[];

  if (rows.length === 0) return [];

  const maxRel = Math.max(...rows.map(r => -r.rank)) || 1;
  return rows
    .map(r => ({ ...r, score: (-r.rank / maxRel) + (r.validated === 1 ? validatedBoost : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rank, ...rest }) => rest);
}
