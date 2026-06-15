import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AIMessage } from '../providers/base';

const SESSION_FILE = '.iacmp/session.json';
const MAX_MESSAGES = 20;

interface SessionData {
  messages: AIMessage[];
  updatedAt: string;
  projectHash?: string;
}

function sessionPath(projectDir: string): string {
  return path.join(projectDir, SESSION_FILE);
}

function hashProject(projectDir: string): string {
  // Hash baseado nos nomes dos arquivos de stack — muda quando stacks são adicionadas/removidas
  const stacksDir = path.join(projectDir, 'stacks');
  if (!fs.existsSync(stacksDir)) return 'empty';
  const findFiles = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...findFiles(full));
      else if (e.name.endsWith('.ts')) files.push(path.relative(projectDir, full));
    }
    return files.sort();
  };
  return crypto.createHash('sha256').update(findFiles(stacksDir).join('\n')).digest('hex').slice(0, 8);
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
    return data.messages ?? [];
  } catch {
    return [];
  }
}

export function saveSession(projectDir: string, messages: AIMessage[]): void {
  const dir = path.dirname(sessionPath(projectDir));
  fs.mkdirSync(dir, { recursive: true });
  const data: SessionData = {
    messages: messages.slice(-MAX_MESSAGES),
    updatedAt: new Date().toISOString(),
    projectHash: hashProject(projectDir),
  };
  fs.writeFileSync(sessionPath(projectDir), JSON.stringify(data, null, 2), 'utf-8');
}

export function clearSession(projectDir: string): void {
  const file = sessionPath(projectDir);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
