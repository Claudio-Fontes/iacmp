import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { ftsNeedsRebuild, rebuildFts, searchExamples, type ScoredExample } from '@iacmp/knowledge';
import { buildBM25Index, bm25Search } from './bm25';
import { Chunk } from './chunker';

// Mesma env do iacmp-mcp — quando setada, os dois leem o MESMO banco (gêmeos).
const DB_PATH = process.env.IACMP_MCP_DB || join(homedir(), '.iacmp', 'knowledge.db');

interface ExampleRow {
  id: string;
  title: string;
  provider: string;
  constructs: string;
  tags: string;
  content: string;
  tokens: string;
  validated?: number;
}

function openDb(): Database.Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    // Read-write: precisamos poder CONSTRUIR o índice FTS se ainda não existir
    // (ex: usuário que só roda `iacmp ai`, sem nunca ter iniciado o servidor MCP).
    const db = new Database(DB_PATH);
    db.pragma('busy_timeout = 3000'); // tolera contenção com o servidor MCP
    return db;
  } catch {
    try { return new Database(DB_PATH, { readonly: true }); } catch { return null; }
  }
}

function truncate(code: string, maxLines = 60): string {
  const lines = code.split('\n');
  return lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n') + '\n// ...'
    : code;
}

// Fallback: BM25 legado sobre a coluna tokens, para bancos read-only sem o índice
// FTS. Retorna as linhas na ordem de relevância. O retrieval canônico (FTS5 +
// boost) vive em @iacmp/knowledge — aqui só o degradê quando não dá para indexar.
function legacySearch(db: Database.Database, query: string, provider: string, limit: number): ExampleRow[] {
  const all = db.prepare(
    `SELECT id, title, provider, constructs, tags, content, tokens, validated FROM examples WHERE provider = ?`
  ).all(provider) as ExampleRow[];
  if (all.length === 0) return [];
  const chunks: Chunk[] = all.map(row => ({
    id: row.id,
    content: (JSON.parse(row.tokens) as string[]).join(' '),
    metadata: { source: 'platform-knowledge' },
  }));
  const index = buildBM25Index(chunks);
  const hits = bm25Search(index, query, limit).filter(h => h.score > 0);
  const rowById = new Map(all.map(r => [r.id, r]));
  return hits.map(h => rowById.get(h.id)).filter((r): r is ExampleRow => !!r);
}

export function searchKnowledgeBase(query: string, provider: string, limit = 2): string {
  const db = openDb();
  if (!db) return '';
  try {
    // Constrói o índice FTS se faltar (usuário só-CLI, sem MCP); silencioso em
    // banco read-only. Se falhar, searchExamples devolve null e caímos no legado.
    try { if (ftsNeedsRebuild(db)) rebuildFts(db); } catch { /* read-only — segue */ }

    const scored: ScoredExample[] | null = searchExamples(db, query, { provider, limit });
    const hitRows: Array<ExampleRow | ScoredExample> = scored ?? legacySearch(db, query, provider, limit);
    if (hitRows.length === 0) return '';

    const parts: string[] = ['## Exemplos da knowledge base (referência estrutural — ✓ validado em deploy real, ○ gerado):'];
    for (const row of hitRows) {
      const content = JSON.parse(row.content) as {
        stacks: Record<string, string>;
        handlers?: Record<string, string>;
        notes?: string | string[];
      };
      const constructs = JSON.parse(row.constructs) as string[];
      const trust = row.validated === 1 ? '✓' : '○';
      parts.push(`\n### ${trust} ${row.title}`);
      parts.push(`constructs: ${constructs.join(', ')}`);
      for (const [filePath, code] of Object.entries(content.stacks)) {
        parts.push(`\`\`\`typescript\n// ${filePath}\n${truncate(code)}\n\`\`\``);
      }
      if (content.handlers) {
        for (const [filePath, code] of Object.entries(content.handlers)) {
          parts.push(`\`\`\`typescript\n// ${filePath}\n${truncate(code, 40)}\n\`\`\``);
        }
      }
      const notesArr = Array.isArray(content.notes)
        ? content.notes
        : typeof content.notes === 'string' && content.notes.length > 0
          ? [content.notes]
          : [];
      if (notesArr.length) {
        parts.push(`Regras:\n${notesArr.slice(0, 3).map(n => `- ${n}`).join('\n')}`);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  } finally {
    db.close();
  }
}
