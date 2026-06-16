/**
 * Testes de intenção do usuário — valida que o sistema entende pedidos implícitos
 * sem que o usuário precise especificar caminhos de arquivo ou detalhes técnicos.
 *
 * Estes testes verificam duas coisas:
 * 1. O contexto injetado (readProjectMeta) sempre expõe os arquivos reais do projeto
 * 2. A resposta gerada (extractResponse) usa os caminhos existentes — não cria arquivos novos
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readProjectMeta } from '../src/tools/context-reader';
import { extractResponse } from '../src/parser/code-extractor';

// Cria um projeto fake em um diretório temporário
function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-test-'));
  fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({
    name: 'meu-projeto', provider: 'aws', region: 'us-east-1', language: 'typescript',
  }));
  const stacksDir = path.join(dir, 'stacks');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(stacksDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  // limpeza automática de temp dirs pelo SO
});

// ─── readProjectMeta ────────────────────────────────────────────────────────

describe('readProjectMeta — exposição de stacks ao modelo', () => {
  test('inclui conteúdo completo de cada arquivo de stack', () => {
    const dir = makeProject({
      'api-gateway-stack.ts': `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api');
new Fn.ApiGateway(stack, 'MyApi', { name: 'my-api', type: 'REST', routes: [] });
export default stack;`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain("### stacks/api-gateway-stack.ts");
    expect(ctx).toContain("new Fn.ApiGateway");
    expect(ctx).toContain("MyApi");
  });

  test('expõe stacks em subdiretórios (compute/, database/)', () => {
    const dir = makeProject({
      'compute/lambda-stack.ts': `const stack = new Stack('lambdas');`,
      'database/dynamo-stack.ts': `const stack = new Stack('db');`,
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('stacks/compute/lambda-stack.ts');
    expect(ctx).toContain('stacks/database/dynamo-stack.ts');
  });

  test('avisa o modelo para não criar arquivos novos se o destino já existe', () => {
    const dir = makeProject({ 'api-gateway-stack.ts': 'export default {};' });
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/não crie.*arquivo.*novo|não cri[ae].*novo.*arquivo|use exatamente estes caminhos/i);
  });

  test('projetos sem stacks retornam aviso adequado', () => {
    // Cria projeto sem diretório stacks
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-test-'));
    fs.writeFileSync(path.join(dir, 'iacmp.json'), JSON.stringify({
      name: 'sem-stacks', provider: 'aws', region: 'us-east-1', language: 'typescript',
    }));
    const ctx = readProjectMeta(dir);
    expect(ctx).toMatch(/não encontrado|nenhuma stack/i);
  });

  test('múltiplos arquivos — todos aparecem no contexto', () => {
    const dir = makeProject({
      'api-gateway-stack.ts': 'ApiGateway aqui',
      'compute/versao-stack.ts': 'Lambda aqui',
      'database/dynamo-stack.ts': 'DynamoDB aqui',
    });
    const ctx = readProjectMeta(dir);
    expect(ctx).toContain('ApiGateway aqui');
    expect(ctx).toContain('Lambda aqui');
    expect(ctx).toContain('DynamoDB aqui');
  });
});

// ─── Validação de respostas do modelo ───────────────────────────────────────
// Simula o que o modelo deveria responder dado um projeto com stacks existentes

describe('resposta do modelo — uso de stacks existentes', () => {
  test('mover ApiGateway para stack existente: path deve ser o existente', () => {
    // O modelo recebe contexto com api-gateway-stack.ts existente e deve usar esse caminho
    const respostaCorreta = JSON.stringify({
      explanation: 'Movendo ApiGateway para a stack existente api-gateway-stack.ts',
      files: [{
        path: 'stacks/api-gateway-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('api');
new Fn.ApiGateway(stack, 'MessagesApi', { name: 'messages-api', type: 'HTTP', cors: true, routes: [
  { method: 'POST', path: '/messages', lambdaId: 'SaveMessageFn' },
  { method: 'GET',  path: '/messages', lambdaId: 'GetMessageFn' },
]});
export default stack;`,
      }],
      deletions: ['stacks/compute/messages-api-gateway-stack.ts'],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(respostaCorreta);
    // Deve usar o caminho existente
    expect(result.files[0].path).toBe('stacks/api-gateway-stack.ts');
    // Deve remover o arquivo duplicado criado anteriormente
    expect(result.deletions).toContain('stacks/compute/messages-api-gateway-stack.ts');
  });

  test('adicionar Lambda a stack existente: não deve criar stack nova', () => {
    const respostaCorreta = JSON.stringify({
      explanation: 'Adicionando GetMessageFn à stack existente',
      files: [{
        path: 'stacks/compute/versao-com-oracle-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('versao-com-oracle');
new Fn.Lambda(stack, 'SaveMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/save-message', memory: 256, timeout: 30, environment: { TABLE_NAME: 'MessagesTable' } });
new Fn.Lambda(stack, 'GetMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/get-message', memory: 256, timeout: 30, environment: { TABLE_NAME: 'MessagesTable' } });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(respostaCorreta);
    // Apenas 1 arquivo modificado — não criou stack nova
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('stacks/compute/versao-com-oracle-stack.ts');
    // Arquivo contém as duas Lambdas
    expect(result.files[0].content).toContain('SaveMessageFn');
    expect(result.files[0].content).toContain('GetMessageFn');
  });

  test('renomear recurso: deve modificar arquivo existente, não criar novo', () => {
    const resposta = JSON.stringify({
      explanation: 'Renomeando HelloWorldFn para ProcessOrderFn na stack existente',
      files: [{
        path: 'stacks/compute/versao-com-oracle-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('versao-com-oracle');
new Fn.Lambda(stack, 'ProcessOrderFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/process-order', memory: 256, timeout: 30 });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toContain('ProcessOrderFn');
    expect(result.files[0].content).not.toContain('HelloWorldFn');
  });

  test('mudar memória de Lambda: só o arquivo da stack afetada é modificado', () => {
    const resposta = JSON.stringify({
      explanation: 'Aumentando memória da SaveMessageFn para 512MB',
      files: [{
        path: 'stacks/compute/versao-com-oracle-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('versao-com-oracle');
new Fn.Lambda(stack, 'SaveMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/save-message', memory: 512, timeout: 30, environment: { TABLE_NAME: 'MessagesTable' } });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toContain('memory: 512');
  });

  test('remover stack: usa deletions com caminho exato', () => {
    const resposta = JSON.stringify({
      explanation: 'Removendo a stack de api gateway duplicada',
      files: [],
      deletions: ['stacks/compute/messages-api-gateway-stack.ts'],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(0);
    expect(result.deletions).toHaveLength(1);
    expect(result.deletions[0]).toBe('stacks/compute/messages-api-gateway-stack.ts');
  });

  test('duas lambdas em stacks separadas: modifica apenas a stack correta', () => {
    const resposta = JSON.stringify({
      explanation: 'Adicionando timeout de 60s apenas na GetMessageFn da stack de leitura',
      files: [{
        path: 'stacks/compute/versao-com-oracle-stack.ts',
        content: `import { Stack, Fn } from '@iacmp/core';
const stack = new Stack('versao-com-oracle');
new Fn.Lambda(stack, 'SaveMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/save-message', memory: 256, timeout: 30, environment: { TABLE_NAME: 'MessagesTable' } });
new Fn.Lambda(stack, 'GetMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/get-message', memory: 256, timeout: 60, environment: { TABLE_NAME: 'MessagesTable' } });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(1);
    // SaveMessageFn mantém timeout 30, GetMessageFn recebe 60
    expect(result.files[0].content).toContain('timeout: 30');
    expect(result.files[0].content).toContain('timeout: 60');
  });

  test('adicionar IAM à stack existente: não cria nova stack de permissões', () => {
    const resposta = JSON.stringify({
      explanation: 'Adicionando Policy.IAM na stack existente da lambda',
      files: [{
        path: 'stacks/compute/versao-com-oracle-stack.ts',
        content: `import { Stack, Fn, Policy } from '@iacmp/core';
const stack = new Stack('versao-com-oracle');
new Fn.Lambda(stack, 'SaveMessageFn', { runtime: 'nodejs20', handler: 'index.handler', code: './src/handlers/save-message', memory: 256, timeout: 30, environment: { TABLE_NAME: 'MessagesTable' } });
new Policy.IAM(stack, 'SaveMessagePolicy', { attachTo: 'SaveMessageFn', attachType: 'lambda', statements: [{ effect: 'Allow', actions: ['dynamodb:PutItem'], resources: ['*'] }] });
export default stack;`,
      }],
      deletions: [],
      nextSteps: [],
      warnings: [],
    });

    const result = extractResponse(resposta);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toContain('Policy.IAM');
    expect(result.files[0].content).toContain('dynamodb:PutItem');
  });
});
