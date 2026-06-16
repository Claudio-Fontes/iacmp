/**
 * Testes de fluxo do chat — simula os cenários completos que causaram bugs:
 * standalone falso, sessão corrompida, contexto injetado na primeira mensagem,
 * contaminação de sessão, detecção de standalone no histórico.
 *
 * Não faz chamadas reais ao modelo — testa a lógica de orquestração.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSession, saveSession, clearSession } from '../src/tools/session-store';
import { readProjectMeta } from '../src/tools/context-reader';
import { ChatSession } from '../src/chat/session';
import { extractResponse } from '../src/parser/code-extractor';

function makeProject(stacks: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-flow-'));
  fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({
    name: 'meu-app', provider: 'aws', region: 'us-east-1', language: 'typescript',
  }));
  for (const [rel, content] of Object.entries(stacks)) {
    const full = path.join(dir, 'stacks', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ─── Detecção de sessão contaminada (chat.js main()) ─────────────────────────

describe('Detecção de sessão contaminada', () => {
  function isContaminated(messages: Array<{ role: string; content: string }>): boolean {
    return messages.some(msg => {
      if (msg.role !== 'assistant') return false;
      try {
        const parsed = JSON.parse(msg.content);
        return typeof parsed.explanation === 'string' &&
          parsed.explanation.toLowerCase().includes('standalone');
      } catch { return false; }
    });
  }

  test('detecta sessão com "modo standalone" na explanation', () => {
    const msgs = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: '{"explanation":"estou em modo standalone sem projeto","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    expect(isContaminated(msgs)).toBe(true);
  });

  test('detecta "standalone" case-insensitive', () => {
    const msgs = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: '{"explanation":"Modo Standalone ativo","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    expect(isContaminated(msgs)).toBe(true);
  });

  test('não detecta sessão limpa como contaminada', () => {
    const msgs = [
      { role: 'user', content: 'cria uma lambda' },
      { role: 'assistant', content: '{"explanation":"Lambda criada em stacks/compute/fn-stack.ts","files":[{"path":"stacks/compute/fn-stack.ts","content":"export default {};"}],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    expect(isContaminated(msgs)).toBe(false);
  });

  test('não detecta sessão apenas com mensagens user como contaminada', () => {
    const msgs = [
      { role: 'user', content: 'standalone como palavra no pedido do usuário' },
    ];
    expect(isContaminated(msgs)).toBe(false);
  });

  test('detecta contaminação em sessão longa (não só na última mensagem)', () => {
    const msgs = [
      { role: 'user', content: 'msg 1' },
      { role: 'assistant', content: '{"explanation":"standalone sem projeto","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
      { role: 'user', content: 'msg 2' },
      { role: 'assistant', content: '{"explanation":"algo útil","files":[],"deletions":[],"nextSteps":[],"warnings":[]}' },
    ];
    expect(isContaminated(msgs)).toBe(true);
  });
});

// ─── Injeção de contexto na primeira mensagem ─────────────────────────────────

describe('Injeção de contexto na primeira mensagem', () => {
  function buildFirstMessage(input: string, freshContext: string): string {
    const isFirstMessage = true;
    const hasStacks = freshContext.includes('Stacks existentes');
    return (isFirstMessage && hasStacks)
      ? `${input}\n\n[Contexto do projeto]\n${freshContext}`
      : input;
  }

  test('primeira mensagem com projeto — inclui contexto', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const ctx = readProjectMeta(dir);
    const msg = buildFirstMessage('cria uma lambda', ctx);
    expect(msg).toContain('[Contexto do projeto]');
    expect(msg).toContain('Stacks existentes');
    expect(msg).toContain('cria uma lambda');
  });

  test('primeira mensagem sem projeto — não injeta contexto', () => {
    const dir = makeProject(); // sem stacks
    const ctx = readProjectMeta(dir);
    const msg = buildFirstMessage('oi', ctx);
    expect(msg).toBe('oi');
    expect(msg).not.toContain('[Contexto do projeto]');
  });

  test('mensagem subsequente (não é a primeira) — não injeta contexto', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const ctx = readProjectMeta(dir);
    const isFirstMessage = false;
    const hasStacks = ctx.includes('Stacks existentes');
    const msg = (isFirstMessage && hasStacks) ? `${ctx}\n\noi` : 'oi';
    expect(msg).toBe('oi');
  });
});

// ─── Fluxo completo: primeira mensagem + sessão ───────────────────────────────

describe('Fluxo completo do chat', () => {
  test('projeto novo: primeira mensagem contém as stacks', () => {
    const dir = makeProject({
      'compute/app-stack.ts': `new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/' });`,
      'network/api-gateway-stack.ts': `new Fn.ApiGateway(stack, 'HelloApi', { name: 'app-api', type: 'REST', routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloWorldFn' }] });`,
    });
    const ctx = readProjectMeta(dir);
    const session = new ChatSession();
    const isFirst = session.getMessages().length === 0;
    const hasStacks = ctx.includes('Stacks existentes');
    const content = (isFirst && hasStacks) ? `Adiciona rota POST\n\n[Contexto do projeto]\n${ctx}` : 'Adiciona rota POST';
    session.addUserMessage(content);

    expect(content).toContain('HelloWorldFn');
    expect(content).toContain('HelloApi');
    expect(content).toContain('stacks/compute/app-stack.ts');
    expect(content).toContain('stacks/network/api-gateway-stack.ts');
  });

  test('resposta bem-sucedida: sessão salva user+assistant', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const session = new ChatSession();
    const userMsg = 'adiciona rota POST';
    const assistantMsg = JSON.stringify({
      explanation: 'Adicionando rota POST à stack existente',
      files: [{ path: 'stacks/network/api-gateway-stack.ts', content: 'export default {};' }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    session.addUserMessage(userMsg);
    session.addAssistantMessage(assistantMsg);
    saveSession(dir, session.getMessages());

    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe(userMsg);
    expect(loaded[1].content).toBe(assistantMsg);
  });

  test('falha na geração: removeLast + não salva sessão', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const session = new ChatSession();

    // sessão prévia
    session.addUserMessage('msg anterior');
    session.addAssistantMessage('{"explanation":"ok","files":[],"deletions":[],"nextSteps":[],"warnings":[]}');
    saveSession(dir, session.getMessages());

    // nova mensagem — modelo falhou
    session.addUserMessage('msg que falhou');
    // simula: runGeneration retornou undefined (erro)
    const responded = undefined;
    if (!responded) session.removeLast();
    // NÃO salva a sessão

    // sessão no disco ainda tem só as 2 mensagens anteriores
    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded[loaded.length - 1].role).toBe('assistant');
  });

  test('resposta conversacional (sem arquivos): sessão salva normalmente', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const session = new ChatSession();

    session.addUserMessage('o que é um NAT Gateway?');
    const resp = JSON.stringify({
      explanation: 'NAT Gateway permite que instâncias em subnets privadas acessem a internet.',
      files: [],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    session.addAssistantMessage(resp);
    // responded = true mesmo sem arquivos
    saveSession(dir, session.getMessages());

    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(2);
    expect(JSON.parse(loaded[1].content).files).toHaveLength(0);
  });

  test('múltiplas trocas: sessão acumula histórico corretamente', () => {
    const dir = makeProject({ 'compute/fn.ts': 'export default {};' });
    const session = new ChatSession();

    const trocas = [
      ['cria uma lambda', 'Lambda criada'],
      ['adiciona rota POST', 'Rota adicionada'],
      ['qual o tamanho da lambda?', 'A lambda usa 128MB'],
    ];

    for (const [user, assistantText] of trocas) {
      session.addUserMessage(user);
      const assistantMsg = JSON.stringify({
        explanation: assistantText,
        files: [],
        deletions: [],
        nextSteps: [],
        warnings: [],
      });
      session.addAssistantMessage(assistantMsg);
      saveSession(dir, session.getMessages());
    }

    const loaded = loadSession(dir);
    expect(loaded).toHaveLength(6); // 3 pares user+assistant
    expect(loaded[0].content).toBe('cria uma lambda');
    expect(JSON.parse(loaded[5].content).explanation).toBe('A lambda usa 128MB');
  });
});

// ─── Cenário do bug reportado: nv-vs-iac1 ────────────────────────────────────

describe('Cenário do bug — nv-vs-iac1', () => {
  test('sessão com 2 user consecutivos é descartada e não contamina nova sessão', () => {
    const dir = makeProject({
      'compute/nv-vs-iac1-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-lambda');
new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10 });
export default stack;`,
      'network/api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-api');
new Fn.ApiGateway(stack, 'HelloWorldApi', { name: 'nv-vs-iac1-api', type: 'REST', stageName: 'prod', cors: true, routes: [{ method: 'GET', path: '/hello', lambdaId: 'HelloWorldFn' }] });
export default stack;`,
    });

    // Simula a sessão corrompida que foi encontrada
    const iacmpDir = path.join(dir, '.iacmp');
    fs.mkdirSync(iacmpDir, { recursive: true });
    fs.writeFileSync(path.join(iacmpDir, 'session.json'), JSON.stringify({
      messages: [
        { role: 'user', content: 'vamos alterar nossa aplicação que exibe um hello World, além um get precisamos de um post.' },
        { role: 'user', content: 'vamos alterar nossa aplicação que exibe um hello World, além um get precisamos de um post.' },
      ],
      updatedAt: new Date().toISOString(),
      projectHash: 'fe44192b',
    }));

    // loadSession deve descartar a sessão corrompida
    const loaded = loadSession(dir);
    expect(loaded).toEqual([]);
  });

  test('após descartar sessão corrompida, nova sessão começa com contexto do projeto', () => {
    const dir = makeProject({
      'compute/nv-vs-iac1-stack.ts': `new Fn.Lambda(stack, 'HelloWorldFn', {});`,
      'network/api-gateway-stack.ts': `new Fn.ApiGateway(stack, 'HelloWorldApi', {});`,
    });

    const ctx = readProjectMeta(dir);
    const session = new ChatSession();

    // Sessão anterior descartada — começa do zero
    expect(session.getMessages()).toHaveLength(0);

    // Primeira mensagem deve conter o contexto
    const input = 'vamos alterar nossa aplicação, além um get precisamos de um post';
    const hasStacks = ctx.includes('Stacks existentes');
    const content = hasStacks ? `${input}\n\n[Contexto do projeto]\n${ctx}` : input;
    session.addUserMessage(content);

    expect(content).toContain('HelloWorldFn');
    expect(content).toContain('HelloWorldApi');
    expect(content).toContain('Stacks existentes');
  });

  test('resposta correta para o pedido de POST: modifica api-gateway-stack existente', () => {
    const respostaCorreta = JSON.stringify({
      explanation: 'Adicionando rota POST /hello ao ApiGateway existente e criando lambda separada para POST',
      files: [
        {
          path: 'stacks/compute/nv-vs-iac1-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-lambda');
new Fn.Lambda(stack, 'HelloWorldGetFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10 });
new Fn.Lambda(stack, 'HelloWorldPostFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10 });
export default stack;`,
        },
        {
          path: 'stacks/network/api-gateway-stack.ts',
          content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('nv-vs-iac1-api');
new Fn.ApiGateway(stack, 'HelloWorldApi', {
  name: 'nv-vs-iac1-api',
  type: 'REST',
  stageName: 'prod',
  cors: true,
  authType: 'NONE',
  routes: [
    { method: 'GET', path: '/hello', lambdaId: 'HelloWorldGetFn' },
    { method: 'POST', path: '/hello', lambdaId: 'HelloWorldPostFn' },
  ],
});
export default stack;`,
        },
      ],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(respostaCorreta);
    // Deve modificar os 2 arquivos existentes — não criar novos
    expect(result.files).toHaveLength(2);
    // Caminhos existentes usados
    expect(result.files[0].path).toBe('stacks/compute/nv-vs-iac1-stack.ts');
    expect(result.files[1].path).toBe('stacks/network/api-gateway-stack.ts');
    // Lambda tem GET e POST separadas
    expect(result.files[0].content).toContain('HelloWorldGetFn');
    expect(result.files[0].content).toContain('HelloWorldPostFn');
    // Gateway tem as duas rotas
    expect(result.files[1].content).toContain("method: 'GET'");
    expect(result.files[1].content).toContain("method: 'POST'");
    // Não deletou nada
    expect(result.deletions).toHaveLength(0);
  });
});

// ─── Cenários adicionais de edição via chat ────────────────────────────────────

describe('Cenários de edição via chat', () => {
  test('aumentar memória da lambda: modifica arquivo existente', () => {
    const resp = JSON.stringify({
      explanation: 'Aumentando memória da HelloWorldFn para 512MB',
      files: [{
        path: 'stacks/compute/app-stack.ts',
        content: `new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 512, timeout: 10 });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].content).toContain('memory: 512');
    expect(result.files).toHaveLength(1);
  });

  test('remover stack: usa deletions com caminho exato', () => {
    const resp = JSON.stringify({
      explanation: 'Removendo stack duplicada de api gateway',
      files: [],
      deletions: ['stacks/compute/api-gateway-stack.ts'],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files).toHaveLength(0);
    expect(result.deletions).toContain('stacks/compute/api-gateway-stack.ts');
  });

  test('adicionar variável de ambiente: modifica stack da lambda', () => {
    const resp = JSON.stringify({
      explanation: 'Adicionando TABLE_NAME ao environment da lambda',
      files: [{
        path: 'stacks/compute/app-stack.ts',
        content: `new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'nodejs20', handler: 'index.handler', code: 'dist/', memory: 128, timeout: 10, environment: { TABLE_NAME: 'MinhaTabela' } });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].content).toContain('TABLE_NAME');
    expect(result.files[0].content).toContain('MinhaTabela');
  });

  test('mudar runtime: modifica arquivo da lambda sem criar novo', () => {
    const resp = JSON.stringify({
      explanation: 'Mudando runtime de nodejs20 para python3.12',
      files: [{
        path: 'stacks/compute/app-stack.ts',
        content: `new Fn.Lambda(stack, 'HelloWorldFn', { runtime: 'python3.12', handler: 'handler.main', code: './src/handlers/hello', memory: 128, timeout: 10 });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].content).toContain("runtime: 'python3.12'");
    expect(result.files).toHaveLength(1);
  });

  test('adicionar DynamoDB: nova stack em database/, não modifica compute/', () => {
    const resp = JSON.stringify({
      explanation: 'Criando tabela DynamoDB em stacks/database/ separada',
      files: [{
        path: 'stacks/database/messages-stack.ts',
        content: `new Database.DynamoDB(stack, 'MessagesTable', { partitionKey: 'id', billingMode: 'PAY_PER_REQUEST' });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].path).toBe('stacks/database/messages-stack.ts');
    expect(result.files[0].content).not.toContain('Fn.Lambda');
    expect(result.files[0].content).toContain('Database.DynamoDB');
  });

  test('adicionar IAM: nova stack em policy/, não mistura com lambda', () => {
    const resp = JSON.stringify({
      explanation: 'IAM para permitir PutItem na tabela',
      files: [{
        path: 'stacks/policy/lambda-policy-stack.ts',
        content: `new Policy.IAM(stack, 'LambdaPolicy', { attachTo: 'HelloWorldFn', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['dynamodb:PutItem'], resources: ['*'] }] });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].path).toMatch('stacks/policy/');
    expect(result.files[0].content).toContain('dynamodb:PutItem');
  });

  test('adicionar secret: nova stack em security/', () => {
    const resp = JSON.stringify({
      explanation: 'Criando secret para credenciais do banco',
      files: [{
        path: 'stacks/security/db-secret-stack.ts',
        content: `new Secret.Vault(stack, 'DbCredentials', { description: 'Credenciais RDS', rotationDays: 30 });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files[0].path).toMatch('stacks/security/');
    expect(result.files[0].content).toContain('Secret.Vault');
  });

  test('resposta explicativa (sem arquivos) é válida e não causa erro', () => {
    const resp = JSON.stringify({
      explanation: 'O ApiGateway fica em stacks/network/ pois é um serviço de Networking segundo a AWS.',
      files: [],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });
    const result = extractResponse(resp);
    expect(result.files).toHaveLength(0);
    expect(result.explanation).toContain('ApiGateway');
  });

  test('resposta com warning de custo é preservada', () => {
    const resp = JSON.stringify({
      explanation: 'RDS Multi-AZ criado',
      files: [{
        path: 'stacks/database/rds-stack.ts',
        content: `new Database.SQL(stack, 'AppDB', { engine: 'mysql', multiAz: true });`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: ['RDS Multi-AZ aumenta custo em ~2x'],
    });
    const result = extractResponse(resp);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/custo/i);
  });
});
