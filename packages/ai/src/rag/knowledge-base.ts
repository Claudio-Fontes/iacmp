import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { buildBM25Index, bm25Search } from './bm25';
import { Chunk } from './chunker';

const DB_PATH = join(homedir(), '.iacmp', 'knowledge.db');

interface ExampleRow {
  id: string;
  title: string;
  provider: string;
  constructs: string;
  content: string;
  tokens: string;
}

function openDb(): Database.Database | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

function truncate(code: string, maxLines = 60): string {
  const lines = code.split('\n');
  return lines.length > maxLines
    ? lines.slice(0, maxLines).join('\n') + '\n// ...'
    : code;
}

export function searchKnowledgeBase(query: string, provider: string, limit = 2): string {
  const db = openDb();
  if (!db) return '';
  try {
    const rows = db.prepare(
      `SELECT id, title, provider, constructs, content, tokens FROM examples WHERE provider = ?`
    ).all(provider) as ExampleRow[];
    if (rows.length === 0) return '';

    // Reusa o BM25 canônico (bm25.ts) para que qualquer ajuste de tokenizer ou
    // scoring se propague. O corpus vem dos tokens já persistidos no banco.
    const chunks: Chunk[] = rows.map(row => ({
      id: row.id,
      content: (JSON.parse(row.tokens) as string[]).join(' '),
      metadata: { source: 'platform-knowledge' },
    }));

    const index = buildBM25Index(chunks);
    const hits = bm25Search(index, query, limit).filter(h => h.score > 0);
    if (hits.length === 0) return '';

    const rowById = new Map(rows.map(r => [r.id, r]));

    const parts: string[] = ['## Exemplos validados (knowledge base — use como referência estrutural):'];
    for (const hit of hits) {
      const row = rowById.get(hit.id);
      if (!row) continue;
      const content = JSON.parse(row.content) as {
        stacks: Record<string, string>;
        handlers?: Record<string, string>;
        notes?: string | string[];
      };
      const constructs = JSON.parse(row.constructs) as string[];
      parts.push(`\n### ${row.title}`);
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
