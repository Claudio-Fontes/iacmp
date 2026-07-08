import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

const K1 = 1.5;
const B = 0.75;
const DB_PATH = join(homedir(), '.iacmp', 'knowledge.db');

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(t => t.length > 1);
}

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

function bm25Score(rows: ExampleRow[], qTokens: string[]): { row: ExampleRow; score: number }[] {
  const avgLen = rows.reduce((s, r) => s + (JSON.parse(r.tokens) as string[]).length, 0) / rows.length;
  const N = rows.length;
  const df: Record<string, number> = {};
  for (const row of rows) {
    const toks = new Set(JSON.parse(row.tokens) as string[]);
    for (const t of qTokens) {
      if (toks.has(t)) df[t] = (df[t] ?? 0) + 1;
    }
  }
  return rows.map(row => {
    const toks = JSON.parse(row.tokens) as string[];
    const dl = toks.length;
    let score = 0;
    for (const t of qTokens) {
      const tf = toks.filter(x => x === t).length;
      if (tf === 0) continue;
      const idf = Math.log((N - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5) + 1);
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgLen)));
    }
    return { row, score };
  });
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

    const qTokens = tokenize(query);
    if (qTokens.length === 0) return '';

    const top = bm25Score(rows, qTokens)
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (top.length === 0) return '';

    const parts: string[] = ['## Exemplos validados (knowledge base — use como referência estrutural):'];
    for (const { row } of top) {
      const content = JSON.parse(row.content) as {
        stacks: Record<string, string>;
        notes?: string[];
      };
      const constructs = JSON.parse(row.constructs) as string[];
      parts.push(`\n### ${row.title}`);
      parts.push(`constructs: ${constructs.join(', ')}`);
      for (const [filePath, code] of Object.entries(content.stacks)) {
        parts.push(`\`\`\`typescript\n// ${filePath}\n${truncate(code)}\n\`\`\``);
      }
      if (content.notes?.length) {
        const rules = content.notes.slice(0, 3).map(n => `- ${n}`).join('\n');
        parts.push(`Regras:\n${rules}`);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  } finally {
    db.close();
  }
}
