import * as fs from 'fs';
import * as path from 'path';
import { AIMessage } from '../providers/base';

const SESSION_FILE = '.iacmp/session.json';
const MAX_MESSAGES = 20;

interface SessionData {
  messages: AIMessage[];
  updatedAt: string;
}

function sessionPath(projectDir: string): string {
  return path.join(projectDir, SESSION_FILE);
}

export function loadSession(projectDir: string): AIMessage[] {
  const file = sessionPath(projectDir);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionData;
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
  };
  fs.writeFileSync(sessionPath(projectDir), JSON.stringify(data, null, 2), 'utf-8');
}

export function clearSession(projectDir: string): void {
  const file = sessionPath(projectDir);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
