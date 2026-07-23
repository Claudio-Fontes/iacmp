// Semeadura do SQLite a partir do corpus versionado (./corpus). Absorve o que
// antes vivia espalhado no iacmp-mcp (db/schema.ts, seed/migrate-static.ts,
// db/repository.ts). Agora AMBOS os consumidores semeiam da mesma fonte:
//  - o servidor MCP, passando sua conexão viva (opts.db) no boot;
//  - o CLI (`iacmp ai`), que abre ~/.iacmp/knowledge.db no primeiro uso — é o
//    que faz a knowledge base chegar ao cliente `npm i -g iacmp` (o corpus viaja
//    embutido no bundle porque @iacmp/knowledge é inlinado no CLI).
//
// Idempotente e barato em regime: um hash do corpus fica gravado em `meta`; se
// bate com o corpus atual e a contagem confere, o seed é pulado.

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';
import { createHash } from 'crypto';
import {
  tokenize, buildFtsText, syncFtsRow, ensureFtsSchema,
  ftsNeedsRebuild, rebuildFts,
} from './index.js';
import { ALL_EXAMPLES, type Example } from './corpus/index.js';

// Mesma env que o CLI e o MCP compartilham — quando setada, os dois leem o
// MESMO banco (gêmeos). Default: ~/.iacmp/knowledge.db.
export function defaultDbPath(): string {
  return process.env.IACMP_MCP_DB || join(homedir(), '.iacmp', 'knowledge.db');
}

// Constructs conhecidos para derivar `constructs` das tags quando o exemplo
// (curado) não os traz explícitos. Legados trazem `constructs` próprios.
const KNOWN_CONSTRUCTS = [
  'lambda', 'dynamodb', 's3', 'rds', 'redis', 'cloudfront', 'cosmos', 'postgresql',
  'container', 'apim', 'api-gateway', 'policy-iam', 'event-grid', 'blob',
];

function deriveProvider(ex: Example): string {
  return ex.provider ?? ex.tags.find(t => ['aws', 'azure', 'gcp'].includes(t)) ?? 'aws';
}
function deriveConstructs(ex: Example): string[] {
  return ex.constructs ?? ex.tags.filter(t => KNOWN_CONSTRUCTS.includes(t));
}

// Cria o schema `examples` + `meta` + índice FTS. Idempotente (IF NOT EXISTS) —
// seguro sobre um banco cru (CLI) ou já criado pelo servidor MCP.
function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS examples (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      provider    TEXT NOT NULL,
      constructs  TEXT NOT NULL,
      tags        TEXT NOT NULL,
      content     TEXT NOT NULL,
      tokens      TEXT NOT NULL,
      validated   INTEGER NOT NULL DEFAULT 1,
      origin      TEXT NOT NULL DEFAULT 'curated',
      provenance  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      embedding   BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_provider ON examples(provider);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Migração idempotente de colunas para bancos criados por versões anteriores
  // (clientes que já tinham ~/.iacmp/knowledge.db).
  //  - origin: 'curated' (corpus oficial) | 'local' (aprendido no deploy do
  //    próprio cliente, Modo 1) | (futuro) 'shared' (community, Modo 2).
  //  - provenance: JSON com { schemaVersion, capturedAt, fingerprint, shareStatus }.
  //    É o metadado que uma base CENTRAL futura lê para rastrear origem e
  //    consentimento; nulo nos curados. Colocado aqui desde já para o Modo 1
  //    nascer forward-compatible com a centralização (Modo 2), sem nova migração.
  const cols = (db.prepare('PRAGMA table_info(examples)').all() as { name: string }[]).map(c => c.name);
  if (!cols.includes('origin')) db.exec("ALTER TABLE examples ADD COLUMN origin TEXT NOT NULL DEFAULT 'curated'");
  if (!cols.includes('provenance')) db.exec('ALTER TABLE examples ADD COLUMN provenance TEXT');
  ensureFtsSchema(db);
}

// Hash do conteúdo do corpus: muda quando um exemplo entra/sai/é editado, o que
// dispara re-seed automático (sem precisar bumpar versão à mão).
function corpusHash(): string {
  const h = createHash('sha1');
  for (const ex of ALL_EXAMPLES) {
    h.update(ex.id);
    h.update(ex.validated ? '1' : '0');
    h.update(JSON.stringify(ex.stacks));
    h.update(JSON.stringify(ex.handlers));
    h.update(JSON.stringify(ex.notes));
    h.update(JSON.stringify(ex.tags));
  }
  return h.digest('hex').slice(0, 16);
}

function getMeta(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function upsertOne(db: Database.Database, ex: Example, origin = 'curated', provenance: string | null = null): void {
  const provider = deriveProvider(ex);
  const constructs = deriveConstructs(ex);
  const content = { stacks: ex.stacks, handlers: ex.handlers, notes: ex.notes };
  const tokens = tokenize([ex.title, ...ex.tags, ...constructs, ...ex.notes].join(' '));
  db.prepare(`
    INSERT INTO examples (id, title, provider, constructs, tags, content, tokens, validated, origin, provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, provider = excluded.provider,
      constructs = excluded.constructs, tags = excluded.tags,
      content = excluded.content, tokens = excluded.tokens,
      validated = excluded.validated, origin = excluded.origin, provenance = excluded.provenance
  `).run(
    ex.id, ex.title, provider,
    JSON.stringify(constructs),
    JSON.stringify(ex.tags),
    JSON.stringify(content),
    JSON.stringify(tokens),
    ex.validated !== false ? 1 : 0,
    origin,
    provenance,
  );
  syncFtsRow(db, ex.id, buildFtsText({ title: ex.title, tags: ex.tags, constructs, content }));
}

export interface SeedResult { seeded: number; dbPath: string; skipped: boolean }

/**
 * Garante que o banco existe e está semeado com o corpus atual. Barato quando já
 * está em dia (checa hash + contagem e pula). Passe `opts.db` para reutilizar
 * uma conexão viva (servidor MCP) — nesse caso a conexão NÃO é fechada aqui.
 */
export function ensureSeeded(opts: { db?: Database.Database; dbPath?: string } = {}): SeedResult {
  const providedDb = opts.db;
  const dbPath = opts.dbPath ?? defaultDbPath();
  let db: Database.Database;
  if (providedDb) {
    db = providedDb;
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
  }
  try {
    ensureSchema(db);
    const want = corpusHash();
    const have = getMeta(db, 'corpus_hash');
    const count = (db.prepare('SELECT count(*) AS n FROM examples').get() as { n: number }).n;
    if (have === want && count >= ALL_EXAMPLES.length) {
      return { seeded: 0, dbPath, skipped: true };
    }
    const tx = db.transaction(() => {
      for (const ex of ALL_EXAMPLES) upsertOne(db, ex);
      setMeta(db, 'corpus_hash', want);
    });
    tx();
    if (ftsNeedsRebuild(db)) rebuildFts(db);
    return { seeded: ALL_EXAMPLES.length, dbPath, skipped: false };
  } finally {
    if (!providedDb) db.close();
  }
}

// ---- Modo 1: aprendizado local (auto-enriquecimento client-side) ----------
// O cliente que opta por `knowledge.autolearn: "local"` no iacmp.json passa a
// gravar, no PRÓPRIO banco, o padrão de um deploy inédito bem-sucedido. Fica só
// nele (origin='local'); não vaza para ninguém. O corpus oficial continua sendo
// a única coisa que o re-seed toca — os locais nunca são apagados.

// Assinatura de dedup: provider + conjunto ordenado de constructs. Dois padrões
// com os mesmos constructs no mesmo provider são "o mesmo padrão" — variações
// não entram, o banco não incha.
function signatureOf(provider: string, constructs: string[]): string {
  return provider + '|' + [...new Set(constructs)].sort().join(',');
}

/**
 * Fingerprint estável de um padrão (provider + constructs). DETERMINÍSTICO — o
 * mesmo padrão gera sempre o mesmo id (`local-<fp>`), então: (a) o próprio cliente
 * não duplica; (b) uma base CENTRAL futura (Modo 2) deduplica contribuições de
 * clientes diferentes pelo mesmo fingerprint, sem adivinhação.
 */
export function fingerprintOf(provider: string, constructs: string[]): string {
  return createHash('sha1').update(signatureOf(provider, constructs)).digest('hex').slice(0, 12);
}

/** Metadado de proveniência gravado com cada exemplo aprendido (forward-compat com o Modo 2). */
export interface Provenance {
  schemaVersion: number;
  capturedAt: string;      // ISO; o chamador (CLI) fornece — o pacote não usa Date
  fingerprint: string;
  shareStatus: 'private' | 'pending' | 'shared';
}

/** true se o banco já tem um exemplo (curado ou local) com o mesmo padrão. */
export function hasSimilarExample(
  opts: { db?: Database.Database; dbPath?: string },
  provider: string,
  constructs: string[],
): boolean {
  const sig = signatureOf(provider, constructs);
  const providedDb = opts.db;
  const db = providedDb ?? new Database(opts.dbPath ?? defaultDbPath(), { readonly: true });
  try {
    const rows = db.prepare('SELECT provider, constructs FROM examples').all() as { provider: string; constructs: string }[];
    return rows.some(r => {
      try { return signatureOf(r.provider, JSON.parse(r.constructs)) === sig; } catch { return false; }
    });
  } finally {
    if (!providedDb) db.close();
  }
}

/**
 * Insere um exemplo aprendido no deploy do próprio cliente (Modo 1). origin='local'
 * o separa do corpus oficial; o re-seed (ensureSeeded) nunca o apaga. Idempotente
 * por id. Ids locais devem usar prefixo próprio (ex: 'local-…') para não colidir.
 */
export function addLocalExample(
  opts: { db?: Database.Database; dbPath?: string },
  ex: Example,
  provenance?: Provenance,
): void {
  const providedDb = opts.db;
  const dbPath = opts.dbPath ?? defaultDbPath();
  let db: Database.Database;
  if (providedDb) {
    db = providedDb;
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
  }
  try {
    ensureSchema(db);
    upsertOne(db, ex, 'local', provenance ? JSON.stringify(provenance) : null);
    if (ftsNeedsRebuild(db)) rebuildFts(db);
  } finally {
    if (!providedDb) db.close();
  }
}
