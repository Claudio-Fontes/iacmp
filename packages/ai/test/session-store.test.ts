import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSession, saveSession, clearSession } from '../src/tools/session-store';

function makeDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-session-'));
  fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({ name: 'test', provider: 'aws' }));
  if (Object.keys(files).length > 0) {
    const stacksDir = path.join(dir, 'stacks');
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(stacksDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return dir;
}

// ─── loadSession ─────────────────────────────────────────────────────────────

describe('loadSession — arquivo inexistente', () => {
  test('retorna [] quando não existe session.json', () => {
    const dir = makeDir();
    expect(loadSession(dir)).toEqual([]);
  });
});

describe('loadSession — sessão válida', () => {
  test('carrega par user+assistant corretamente', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'cria uma lambda' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].role).toBe('user');
    expect(loaded[1].role).toBe('assistant');
  });

  test('carrega múltiplos pares user+assistant', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'mensagem 1' },
      { role: 'assistant' as const, content: '{"explanation":"resp 1","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
      { role: 'user' as const, content: 'mensagem 2' },
      { role: 'assistant' as const, content: '{"explanation":"resp 2","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    expect(loadSession(dir)).toHaveLength(4);
  });

  test('limita a MAX_MESSAGES (20) mensagens', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const msgs = Array.from({ length: 30 }, (_, i) => [
      { role: 'user' as const, content: `msg ${i}` },
      { role: 'assistant' as const, content: `{"explanation":"r${i}","files":[],"deletions":[],"nextSteps":[],"warnings":[]}` },
    ]).flat();
    saveSession(dir, msgs);
    expect(loadSession(dir).length).toBeLessThanOrEqual(20);
  });
});

describe('loadSession — sessão malformada', () => {
  test('descarta sessão que termina com user sem resposta', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const iacmpDir = path.join(dir, '.iacmp');
    fs.mkdirSync(iacmpDir, { recursive: true });
    fs.writeFileSync(path.join(iacmpDir, 'session.json'), JSON.stringify({
      messages: [
        { role: 'user', content: 'mensagem sem resposta' },
      ],
      updatedAt: new Date().toISOString(),
    }));
    expect(loadSession(dir)).toEqual([]);
  });

  test('descarta sessão com dois user consecutivos', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const iacmpDir = path.join(dir, '.iacmp');
    fs.mkdirSync(iacmpDir, { recursive: true });
    fs.writeFileSync(path.join(iacmpDir, 'session.json'), JSON.stringify({
      messages: [
        { role: 'user', content: 'msg 1' },
        { role: 'user', content: 'msg 2' },
        { role: 'assistant', content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
      ],
      updatedAt: new Date().toISOString(),
    }));
    expect(loadSession(dir)).toEqual([]);
  });

  test('descarta sessão com JSON inválido', () => {
    const dir = makeDir();
    const iacmpDir = path.join(dir, '.iacmp');
    fs.mkdirSync(iacmpDir, { recursive: true });
    fs.writeFileSync(path.join(iacmpDir, 'session.json'), 'ISSO NAO EH JSON');
    expect(loadSession(dir)).toEqual([]);
  });

  test('descarta sessão vazia (sem mensagens)', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const iacmpDir = path.join(dir, '.iacmp');
    fs.mkdirSync(iacmpDir, { recursive: true });
    fs.writeFileSync(path.join(iacmpDir, 'session.json'), JSON.stringify({
      messages: [],
      updatedAt: new Date().toISOString(),
    }));
    // sessão vazia é válida — retorna []
    expect(loadSession(dir)).toEqual([]);
  });
});

describe('loadSession — invalidação por hash de projeto', () => {
  test('descarta sessão quando stacks mudaram desde a última sessão', () => {
    const dir = makeDir({ 'compute/fn-stack.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);

    // Adiciona nova stack — muda o hash
    const newStack = path.join(dir, 'stacks', 'database', 'db-stack.ts');
    fs.mkdirSync(path.dirname(newStack), { recursive: true });
    fs.writeFileSync(newStack, 'export default {};');

    expect(loadSession(dir)).toEqual([]);
  });

  test('mantém sessão quando stacks não mudaram', () => {
    const dir = makeDir({ 'compute/fn-stack.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    expect(loadSession(dir)).toHaveLength(2);
  });

  test('carrega sessão de projeto sem stacks (hash stable)', () => {
    const dir = makeDir(); // sem stacks
    const msgs = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    expect(loadSession(dir)).toHaveLength(2);
  });
});

describe('loadSession — sessão com explanation standalone', () => {
  test('carrega normalmente — a detecção de standalone é responsabilidade do chat.js', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"modo standalone sem projeto","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    // session-store não filtra standalone — isso é feito no chat.js
    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(2);
  });
});

// ─── saveSession ──────────────────────────────────────────────────────────────

describe('saveSession', () => {
  test('cria .iacmp/session.json com mensagens e hash', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    const msgs = [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    saveSession(dir, msgs);
    const file = path.join(dir, '.iacmp', 'session.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(data.messages).toHaveLength(2);
    expect(data.projectHash).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  test('sobrescreve sessão anterior', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    saveSession(dir, [
      { role: 'user' as const, content: 'msg 1' },
      { role: 'assistant' as const, content: '{"explanation":"r1","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ]);
    saveSession(dir, [
      { role: 'user' as const, content: 'msg 2' },
      { role: 'assistant' as const, content: '{"explanation":"r2","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ]);
    expect(loadSession(dir)[0].content).toBe('msg 2');
  });
});

// ─── clearSession ─────────────────────────────────────────────────────────────

describe('clearSession', () => {
  test('remove o arquivo de sessão', () => {
    const dir = makeDir({ 'compute/fn.ts': 'export default {};' });
    saveSession(dir, [
      { role: 'user' as const, content: 'oi' },
      { role: 'assistant' as const, content: '{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ]);
    clearSession(dir);
    expect(loadSession(dir)).toEqual([]);
  });

  test('não lança erro se o arquivo não existe', () => {
    const dir = makeDir();
    expect(() => clearSession(dir)).not.toThrow();
  });
});
