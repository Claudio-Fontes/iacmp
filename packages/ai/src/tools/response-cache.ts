import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const CACHE_FILE = '.iacmp/cache.json';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

interface CacheEntry {
  hash: string;
  prompt: string;
  response: string;
  createdAt: string;
}

interface CacheData {
  entries: CacheEntry[];
}

function cachePath(projectDir: string): string {
  return path.join(projectDir, CACHE_FILE);
}

function loadCache(projectDir: string): CacheData {
  const file = cachePath(projectDir);
  if (!fs.existsSync(file)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheData;
  } catch {
    return { entries: [] };
  }
}

function saveCache(projectDir: string, data: CacheData): void {
  const dir = path.dirname(cachePath(projectDir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath(projectDir), JSON.stringify(data, null, 2), 'utf-8');
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 16);
}

export function getCached(projectDir: string, prompt: string): string | null {
  const hash = hashPrompt(prompt);
  const data = loadCache(projectDir);
  const entry = data.entries.find(e => e.hash === hash);
  if (!entry) return null;

  const age = Date.now() - new Date(entry.createdAt).getTime();
  if (age > TTL_MS) return null;

  return entry.response;
}

export function setCache(projectDir: string, prompt: string, response: string): void {
  const hash = hashPrompt(prompt);
  const data = loadCache(projectDir);

  // Remove entrada existente com mesmo hash
  data.entries = data.entries.filter(e => e.hash !== hash);

  data.entries.push({
    hash,
    prompt: prompt.slice(0, 200),
    response,
    createdAt: new Date().toISOString(),
  });

  saveCache(projectDir, data);
}

export function clearCache(projectDir: string): void {
  const file = cachePath(projectDir);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
