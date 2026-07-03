import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AIMessage } from '../providers/base';

const SESSION_FILE = '.iacmp/session.json';
const TOKEN_BUDGET = 40_000;

function estimateTokens(messages: AIMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

function trimToTokenBudget(messages: AIMessage[]): AIMessage[] {
  if (messages.length <= 2) return messages;
  let trimmed = [...messages];
  while (trimmed.length > 2 && estimateTokens(trimmed) > TOKEN_BUDGET) {
    trimmed = trimmed.slice(1);
  }
  // Garante que a primeira mensagem é sempre 'user' (nunca esvazia o array)
  while (trimmed.length > 1 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

interface SessionData {
  messages: AIMessage[];
  updatedAt: string;
  projectHash?: string;
}

function sessionPath(projectDir: string): string {
  return path.join(projectDir, SESSION_FILE);
}

function hashProject(projectDir: string): string {
  const stacksDir = path.join(projectDir, 'stacks');
  if (!fs.existsSync(stacksDir)) return 'empty';
  const findFiles = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...findFiles(full));
      else if (e.name.endsWith('.ts')) files.push(full);
    }
    return files.sort();
  };
  const hash = crypto.createHash('sha256');
  for (const filePath of findFiles(stacksDir)) {
    const rel = path.relative(projectDir, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    hash.update(rel + content);
  }
  return hash.digest('hex').slice(0, 8);
}

export function loadSession(projectDir: string): AIMessage[] {
  const file = sessionPath(projectDir);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionData;
    // Se as stacks mudaram desde a última sessão, descarta — evita contexto desatualizado
    const currentHash = hashProject(projectDir);
    if (data.projectHash && data.projectHash !== currentHash) {
      return [];
    }
    const messages = data.messages ?? [];
    // Descarta sessão malformada: não pode terminar com mensagem do usuário sem resposta
    // nem ter dois 'user' consecutivos
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i].role === 'user' && messages[i + 1].role === 'user') return [];
    }
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') return [];
    return messages;
  } catch {
    return [];
  }
}

export function saveSession(projectDir: string, messages: AIMessage[]): void {
  const dir = path.dirname(sessionPath(projectDir));
  fs.mkdirSync(dir, { recursive: true });
  const data: SessionData = {
    messages: trimToTokenBudget(messages),
    updatedAt: new Date().toISOString(),
    projectHash: hashProject(projectDir),
  };
  fs.writeFileSync(sessionPath(projectDir), JSON.stringify(data, null, 2), 'utf-8');
}

export function clearSession(projectDir: string): void {
  const file = sessionPath(projectDir);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
