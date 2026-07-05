import { Command, Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import {
  AIProvider,
  AnthropicProvider,
  OpenAIProvider,
  CopilotProvider,
  ChatSession,
  extractResponse,
  validateTypeScript,
  writeGeneratedFiles,
  removeOrphanedGeneratedFiles,
  runSynth,
  runSynthCapture,
  readProjectContext,
  printExplanation,
  printWarnings,
  printNextSteps,
  buildSystemPrompt,
  AIGeneratedResponse,
  getCached,
  setCache,
  buildIndexes,
  retrieve,
  formatRetrievedContext,
} from '@iacmp/ai';
import { ensureProjectInitialized } from '../bootstrap';

type AskFn = (question: string) => Promise<string>;

// Arquivos gerenciados pelo projeto/bootstrap — a IA nunca deve gerá-los.
const PROTECTED_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'iacmp.json', '.env', '.gitignore']);

// Um pacote traz tipos próprios quando declara "types"/"typings" no package.json
// ou expõe um index.d.ts na raiz. Se não, o handler que o importa precisa do
// @types/<pkg> pra passar no tsc do projeto (noImplicitAny).
function hasBundledTypes(cwd: string, mod: string): boolean {
  const modDir = path.join(cwd, 'node_modules', mod);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf-8'));
    if (pkg.types || pkg.typings) return true;
  } catch { /* sem package.json legível */ }
  return fs.existsSync(path.join(modDir, 'index.d.ts'));
}


// Instala módulos "Cannot find module" dos erros TS (com os filtros de SDK do
// Azure) e retorna true se instalou algo. Usado ANTES do loop e DENTRO do loop
// de synth — sem isso, um SDK trocado no meio das correções (ex: data-tables→pg)
// nunca instala e o loop queima todas as rodadas em TS2307 (ciclo p01az7).
function tryInstallMissingModules(errors: string[], cwd: string, iacProvider: string, files: Array<{ path: string; content: string }>): boolean {
  const missingModules = errors
    .map(e => e.match(/Cannot find module '([^']+)'/))
    .filter(Boolean)
    .map(m => m![1])
    .filter(pkg => !pkg.startsWith('.') && !pkg.startsWith('@iacmp/'))
    .filter((v, i, a) => a.indexOf(v) === i);
  const stacksBlob = files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
  // data-tables só é o SDK certo quando há Database.DynamoDB — em projeto sem
  // DynamoDB (SQL→pg, blob→storage-blob), NÃO instalar (mascararia o SDK errado
  // e o detector do loop nunca forçaria a troca).
  const noDynamoAzure = iacProvider === 'azure' && !stacksBlob.includes('Database.DynamoDB');
  const modulesToInstall = iacProvider === 'azure'
    ? missingModules.filter(pkg => !pkg.startsWith('@aws-sdk/') && !(noDynamoAzure && pkg === '@azure/data-tables'))
    : missingModules;
  if (modulesToInstall.length === 0) return false;
  const installSpinner = ora({ text: `Instalando dependências: ${modulesToInstall.join(', ')}...`, spinner: 'dots', discardStdin: false }).start();
  try {
    cp.execSync(`npm install ${modulesToInstall.join(' ')}`, { cwd, stdio: 'pipe' });
    const typesPkgs = modulesToInstall
      .filter(m => !m.startsWith('@'))
      .filter(m => !hasBundledTypes(cwd, m))
      .map(m => `@types/${m}`);
    for (const t of typesPkgs) {
      try { cp.execSync(`npm install -D ${t}`, { cwd, stdio: 'pipe' }); } catch { /* sem @types — ignora */ }
    }
    installSpinner.succeed(`Instalado: ${[...modulesToInstall, ...typesPkgs].join(', ')}`);
    return true;
  } catch {
    installSpinner.fail(`Falha ao instalar ${modulesToInstall.join(', ')}`);
    return false;
  }
}

/**
 * Detector programático de SDK errado nos handlers Azure. Retorna a mensagem de
 * correção (com o SDK certo pro datastore do projeto) ou null se tudo ok.
 * Roda INDEPENDENTE do TS: o SDK errado costuma SER a causa do erro de compilação
 * (ex: TableClient.getSignedUrl não existe num cenário de blob).
 */
function buildAzureSdkCorrection(files: Array<{ path: string; content: string }>): string | null {
  const stacksBlob = files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
  const hasDynamo = stacksBlob.includes('Database.DynamoDB');
  const sqlOnly = stacksBlob.includes('Database.SQL') && !hasDynamo;
  const blobOnly = stacksBlob.includes('Storage.Bucket') && !hasDynamo && !stacksBlob.includes('Database.SQL');
  const handlerFiles = files.filter(f => (f.path.startsWith('src/') || f.path.endsWith('.ts')) && !f.path.startsWith('stacks/'));
  const awsSdkFiles = handlerFiles.filter(f => f.content.includes('@aws-sdk/'));
  // data-tables/cosmos só é correto com Database.DynamoDB — em SQL (→pg) ou
  // blob (→storage-blob) é o SDK errado.
  const wrongTableFiles = (sqlOnly || blobOnly)
    ? handlerFiles.filter(f => f.content.includes('@azure/data-tables') || f.content.includes('@azure/cosmos'))
    : [];
  if (awsSdkFiles.length === 0 && wrongTableFiles.length === 0) return null;
  const fileList = [...new Set([...awsSdkFiles, ...wrongTableFiles].map(f => f.path))].join(', ');
  const sdkExample = sqlOnly
    ? `Reescreva APENAS esses handlers usando o driver pg (o banco é PostgreSQL flexible server):\n` +
      `\`\`\`typescript\n` +
      `import { Client } from 'pg';\n` +
      `const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });\n` +
      `\`\`\`\n\n` +
      `Env vars: DB_HOST: ref('AppDB','Endpoint'), DB_PORT: ref('AppDB','Port'), DB_USER: ref('AppDB','Username'), DB_PASSWORD: ref('AppDB','Password').\n` +
      `NUNCA @azure/data-tables/@azure/cosmos (é Cosmos, outro produto) nem @aws-sdk/*.`
    : blobOnly
    ? `Este projeto é de ARQUIVOS/BLOB (Storage.Bucket, sem banco). Reescreva APENAS esses handlers com @azure/storage-blob (presigned = SAS URL). Use fromConnectionString (NÃO invente BLOB_KEY placeholder) e crie o container:\n` +
      `\`\`\`typescript\n` +
      `import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from '@azure/storage-blob';\n` +
      `const svc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n` +
      `const container = svc.getContainerClient('uploads'); await container.createIfNotExists();\n` +
      `const cred = svc.credential as StorageSharedKeyCredential;\n` +
      `// SAS: generateBlobSASQueryParameters({ containerName:'uploads', blobName, permissions: BlobSASPermissions.parse('cw'), expiresOn: new Date(Date.now()+3e5) }, cred).toString()\n` +
      `// list: for await (const b of container.listBlobsFlat()){...}  // delete: await container.deleteBlob(name)\n` +
      `\`\`\`\n\n` +
      `Env var ÚNICA: BLOB_CONNECTION: ref('<Bucket>','ConnectionString'). NÃO gere BLOB_KEY/BLOB_ACCOUNT/COSMOS_CONNECTION/TABLE_NAME. NUNCA @azure/data-tables/@azure/cosmos nem @aws-sdk/*.`
    : `Reescreva APENAS esses handlers usando @azure/data-tables:\n` +
      `\`\`\`typescript\n` +
      `import { TableClient } from '@azure/data-tables';\n` +
      `const client = TableClient.fromConnectionString(process.env.COSMOS_CONNECTION!, process.env.TABLE_NAME!);\n` +
      `// createEntity({partitionKey,rowKey,...}) / listEntities() / getEntity(pk,rk) / updateEntity(...,'Replace') / deleteEntity(pk,rk)\n` +
      `\`\`\`\n\n` +
      `Env vars: COSMOS_CONNECTION: ref('ItemsTable','ConnectionString'), TABLE_NAME: ref('ItemsTable','Name'). NUNCA @aws-sdk/*.`;
  return `ERRO AZURE: os handlers ${fileList} usam o SDK errado para o datastore deste projeto.\n\n` +
    sdkExample + `\n\n` +
    `Retorne o JSON completo com TODOS os ${files.length} arquivo(s) da resposta anterior (corrija os handlers + as env vars dos Fn.Lambda nas stacks).`;
}

function stripProtectedFiles(parsed: AIGeneratedResponse): void {
  const dropped = parsed.files.filter(f => PROTECTED_FILES.has(f.path.split('/').pop() ?? ''));
  if (dropped.length > 0) {
    parsed.files = parsed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop() ?? ''));
    console.log(chalk.dim(`  (ignorando ${dropped.map(f => f.path).join(', ')} — gerenciados pelo projeto, não pela IA)`));
  }
}

// Prompt de auto-revisão: a IA critica a própria resposta contra o pedido,
// focando nos modos de falha que TS/synth NÃO pegam (erros de intenção).
const REVIEW_PROMPT = (fileCount: number): string =>
  `Antes de finalizar, revise sua resposta anterior como um engenheiro sênior revisando um Pull Request, comparando-a com o pedido ORIGINAL do usuário. Verifique CADA item:\n` +
  `1. REQUISITOS: todo requisito explícito do pedido está implementado? Liste mentalmente o que faltou.\n` +
  `1b. SEPARAÇÃO POR CAMADA: os recursos estão divididos em múltiplas stacks por camada (network/database/compute/security/...), NÃO tudo num arquivo só? Se houver VPC+banco+lambdas+secret juntos num único arquivo, SEPARE em stacks distintas nas subpastas corretas.\n` +
  `2. PONTO DE ENTRADA HTTP (crítico): uma "API REST/HTTP" servida por Lambdas EXIGE um Fn.ApiGateway com routes[] apontando para cada lambdaId. Se NENHUM arquivo tiver Fn.ApiGateway, a API está INCOMPLETA — CRIE stacks/network/api-gateway-stack.ts com Fn.ApiGateway (type: 'HTTP', cors: true, e uma rota por método/Lambda). NUNCA use Network.LoadBalancer para isso (ALB é para containers/EC2).\n` +
  `3. CRUD COMPLETO: todas as operações pedidas (listar, obter, criar, atualizar, deletar) existem e estão wireadas nas rotas.\n` +
  `4. SCHEMA E SQL: a tabela tem TODOS os campos da spec; o handler de listagem cria a tabela (CREATE TABLE IF NOT EXISTS) com todos os campos; INSERT/UPDATE leem e escrevem todos os campos; a contagem de colunas BATE com a de valores ($1,$2,...); SQL parametrizado.\n` +
  `5. REFERÊNCIAS: env vars de banco usam o id real do Database (ex: AppDB.Endpoint); rotas usam os lambdaId reais.\n` +
  `6. IAM: toda Lambda que acessa um serviço AWS (DynamoDB, S3, SQS, SNS, Secrets Manager, etc.) TEM uma Policy.IAM anexada (attachTo) com as actions mínimas necessárias? Sem isso a Lambda dá AccessDenied em runtime. Se faltar, ADICIONE a Policy.IAM.\n\n` +
  `Se encontrar QUALQUER defeito, retorne o JSON COMPLETO CORRIGIDO com os ${fileCount} arquivo(s) (todos, não só os corrigidos). Se estiver tudo perfeito, retorne exatamente o mesmo JSON. Responda APENAS com o JSON, sem texto antes ou depois.`;

// Recupera conhecimento (docs de construct + padrões de plataforma) relevante
// ao pedido e o formata para injeção no contexto da geração. Usa só BM25
// (offline, sem API key) — rápido. Falha graciosamente: sem RAG, a geração
// segue só com o system-prompt. É o que tira regras de padrão do prompt fixo e
// as torna conhecimento consultável (ex: "separar stacks por camada").
async function retrieveGenerationContext(cwd: string, prompt: string, systemPromptTemplate: string): Promise<string> {
  try {
    const indexes = await buildIndexes({ projectDir: cwd, systemPromptTemplate });
    // Foco em docs (API dos constructs) e knowledge (padrões/limites) — as
    // stacks do projeto já entram via readProjectContext.
    // docsK=0: docs já estão no system prompt (redundante + pesa no TPM do gpt-4o)
    const results = retrieve(indexes, prompt, { projectK: 0, sourceK: 0, docsK: 0, knowledgeK: 4 });
    return formatRetrievedContext(results);
  } catch {
    return '';
  }
}

function resolveAIProvider(): AIProvider {
  const model = process.env['IACMP_MODEL'];
  const preferred = process.env['IACMP_PROVIDER_AI']?.toLowerCase();

  if (preferred === 'openai' && process.env['OPENAI_API_KEY']) {
    return new OpenAIProvider(process.env['OPENAI_API_KEY'], model);
  }
  if (preferred === 'anthropic' && process.env['ANTHROPIC_API_KEY']) {
    return new AnthropicProvider(process.env['ANTHROPIC_API_KEY'], model);
  }
  if (preferred === 'copilot' && process.env['GITHUB_TOKEN']) {
    return new CopilotProvider(process.env['GITHUB_TOKEN']);
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    return new AnthropicProvider(process.env['ANTHROPIC_API_KEY'], model);
  }
  if (process.env['OPENAI_API_KEY']) {
    return new OpenAIProvider(process.env['OPENAI_API_KEY'], model);
  }
  if (process.env['GITHUB_TOKEN']) {
    return new CopilotProvider(process.env['GITHUB_TOKEN']);
  }
  throw new Error(
    'Configure ANTHROPIC_API_KEY ou OPENAI_API_KEY no .env do projeto'
  );
}

function resolveIaCProvider(flags: { provider?: string }, cwd: string): string {
  if (flags.provider) return flags.provider;
  const configPath = path.join(cwd, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (typeof config['provider'] === 'string') return config['provider'];
    } catch { /* ignora */ }
  }
  return 'aws';
}

// Ask simples via readline — apenas para modo direto (sem --chat). Uma única
// interface reaproveitada pra TODAS as perguntas da execução (ex: confirmar
// escrita dos arquivos E DEPOIS perguntar se quer rodar `iacmp synth`) — fechar
// a cada pergunta (regressão anterior) deixava a segunda chamada quebrar com
// "Error: readline was closed" assim que houvesse mais de uma pergunta na
// mesma execução. Quem chama `createDirectAsk` é responsável por fechar com
// `close()` ao final.
function createDirectAsk(): { ask: AskFn; close: () => void } {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question: string) => new Promise(resolve => {
      rl.question(question, (answer: string) => resolve(answer.trim()));
    }),
    close: () => rl.close(),
  };
}

function createContextualProvider(base: AIProvider, projectContext: string, iacProvider: string): AIProvider {
  const systemPrompt = buildSystemPrompt(projectContext, undefined, iacProvider);
  return {
    name: base.name,
    async chat(messages) {
      return base.chat([{ role: 'system' as const, content: systemPrompt }, ...messages]);
    },
    async stream(messages, onChunk) {
      return base.stream([{ role: 'system' as const, content: systemPrompt }, ...messages], onChunk);
    },
  };
}

async function runGeneration(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  dryRun: boolean,
  iacProvider: string,
  ask: AskFn,
  lastUserPrompt: string
): Promise<AIGeneratedResponse | null> {
  const cached = getCached(cwd, lastUserPrompt);
  let raw: string = '';
  let fromCache = false;

  if (cached) {
    // Só usa o cache se o conteúdo for JSON válido
    try {
      extractResponse(cached);
      console.log(chalk.dim('  ↩ resposta do cache'));
      raw = cached;
      fromCache = true;
      session.addAssistantMessage(raw);
    } catch {
      // Cache envenenado — descarta
      raw = '';
    }
  }

  if (!raw) {
    // discardStdin: false — por padrão a ora cria sua PRÓPRIA readline.Interface
    // em process.stdin pra capturar Ctrl+C enquanto o spinner gira, e o close()
    // dela ao terminar quebra a nossa própria interface (criada em
    // createDirectAsk) pra qualquer pergunta feita DEPOIS do spinner — a leitura
    // simplesmente trava sem nunca receber a resposta. Só acontece com stdin
    // TTY (terminal real), por isso não aparecia em testes automatizados.
    const spinner = ora({ text: 'Gerando...', spinner: 'dots', discardStdin: false }).start();
    const chunks: string[] = [];
    let accumulated = '';
    const announced = new Set<string>();
    try {
      await provider.stream(session.getMessages(), chunk => {
        chunks.push(chunk);
        accumulated += chunk;
        const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = pathRegex.exec(accumulated)) !== null) {
          if (!announced.has(m[1])) {
            announced.add(m[1]);
            spinner.text = `Gerando ${m[1]}...`;
          }
        }
      });
    } catch (err) {
      spinner.fail('Erro ao chamar a IA: ' + (err as Error).message);
      return null;
    }
    spinner.succeed('Resposta recebida');
    raw = chunks.join('');
    session.addAssistantMessage(raw);
  }

  let parsed: AIGeneratedResponse;
  try {
    parsed = extractResponse(raw);
  } catch {
    // Resposta conversacional — exibe como texto sem gravar no cache
    console.log('\n' + raw.trim() + '\n');
    return null;
  }

  // Só grava no cache após parse bem-sucedido
  if (!fromCache) {
    setCache(cwd, lastUserPrompt, raw);
  }

  // Arquivos de projeto/ambiente são do bootstrap, NÃO da IA. Quando a IA os
  // reescreve (ex: package.json), ela clobbera o link do @iacmp/core e remove
  // ts-node/typescript — e o synth para de carregar as stacks. Descarta esses
  // arquivos da resposta antes de escrever.
  stripProtectedFiles(parsed);

  // ── Auto-revisão semântica ────────────────────────────────────────────────
  // O TS/synth pegam erros estruturais, mas NÃO erros de lógica/intenção
  // (construct errado — ALB no lugar de ApiGateway, CRUD incompleto, schema
  // faltando, SQL ruim). Aqui a IA revisa a própria resposta contra o pedido,
  // como um sênior revisando PR, e devolve o JSON corrigido. Pula no cache
  // (já revisado antes) e em resposta sem arquivos (conversacional).
  if (!fromCache && parsed.files.length > 0) {
    const spinner = ora({ text: 'Auto-revisão da geração...', spinner: 'dots', discardStdin: false }).start();
    session.addUserMessage(REVIEW_PROMPT(parsed.files.length));
    const reviewChunks: string[] = [];
    try {
      await provider.stream(session.getMessages(), chunk => reviewChunks.push(chunk));
      const reviewRaw = reviewChunks.join('');
      session.addAssistantMessage(reviewRaw);
      try {
        const reviewed = extractResponse(reviewRaw);
        if (reviewed.files.length > 0) {
          stripProtectedFiles(reviewed);
          // MERGE por path: a revisão sobrescreve/adiciona, mas arquivos da
          // geração original que a revisão NÃO mencionou são MANTIDOS — senão
          // uma revisão que devolve menos arquivos apagaria stacks (ex: dropar
          // a api-gateway-stack e deixar as Lambdas sem entrada HTTP).
          const byPath = new Map(parsed.files.map(f => [f.path, f]));
          for (const f of reviewed.files) byPath.set(f.path, f);
          const merged = [...byPath.values()];
          const changed = JSON.stringify(merged) !== JSON.stringify(parsed.files);
          reviewed.files = merged;
          parsed = reviewed;
          spinner.succeed(changed ? 'Auto-revisão aplicou correções' : 'Auto-revisão: nada a corrigir');
        } else {
          spinner.stop();
        }
      } catch {
        spinner.stop(); // revisão não retornou JSON — mantém o original
      }
    } catch (err) {
      spinner.warn('Auto-revisão falhou (seguindo com a geração original): ' + (err as Error).message);
    }
  }

  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    let result = validateTypeScript(tsFiles, cwd);

    // Detecta "Cannot find module 'X'" e instala os pacotes faltantes antes de
    // mandar pra IA — evita que a IA troque por outra lib que também não existe.
    if (!result.valid) {
      if (tryInstallMissingModules(result.errors, cwd, iacProvider, parsed.files)) {
        result = validateTypeScript(tsFiles, cwd);
      }
    }

    if (!result.valid) {
      const spinner = ora({ text: 'Validação TypeScript falhou — corrigindo...', spinner: 'dots', discardStdin: false }).start();
      const originalFileCount = parsed.files.length;
      // Prioridade: detectar SDK errado no Azure ANTES do hint genérico.
      // @aws-sdk/* é a causa mais comum de "Cannot find module" em projetos Azure —
      // o hint genérico abaixo (data-tables) seria o SDK ERRADO para blob.
      // buildAzureSdkCorrection já tem a lógica correta por datastore.
      const azureSdkFirst = iacProvider === 'azure' ? buildAzureSdkCorrection(parsed.files) : null;
      let tsHint: string;
      if (azureSdkFirst) {
        tsHint = `\n\n${azureSdkFirst}`;
      } else {
        // O hint Azure precisa ser ciente do DATASTORE do projeto: mandar
        // data-tables num projeto Database.SQL (postgres) cria a espiral inversa
        // (foi a causa do 5/5 do ciclo p01az4). data-tables é SÓ para DynamoDB.
        // Storage.Bucket sem DynamoDB → storage-blob (não data-tables).
        const stacksBlob = parsed.files.filter(f => f.path.startsWith('stacks/')).map(f => f.content).join('\n');
        const hasDynamo = stacksBlob.includes('Database.DynamoDB');
        const hasSql = stacksBlob.includes('Database.SQL');
        const hasBlob = stacksBlob.includes('Storage.Bucket');
        tsHint = iacProvider === 'azure'
          ? (hasSql && !hasDynamo
            ? `\n\nEste projeto Azure usa Database.SQL (PostgreSQL flexible server) — os handlers usam o driver pg NORMAL:\n` +
              `  import { Client } from 'pg';\n` +
              `  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'postgres', ssl: { rejectUnauthorized: false } });\n` +
              `NUNCA use @azure/data-tables (é Cosmos DB Table, outro produto) nem @aws-sdk/*.`
            : (hasBlob && !hasDynamo)
            ? `\n\nEste projeto Azure é de ARQUIVOS/BLOB (Storage.Bucket). Use @azure/storage-blob:\n` +
              `  import { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } from '@azure/storage-blob';\n` +
              `  const svc = BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION!);\n` +
              `  const container = svc.getContainerClient('uploads'); await container.createIfNotExists();\n` +
              `NUNCA use @azure/data-tables (é NoSQL Cosmos, não blob) nem @aws-sdk/*.`
            : `\n\nEste projeto usa Azure Container Apps — use APENAS @azure/data-tables para acesso a Cosmos DB:\n` +
              `  import { TableClient } from '@azure/data-tables';\n` +
              `  const client = TableClient.fromConnectionString(process.env.COSMOS_CONNECTION!, process.env.TABLE_NAME!);\n` +
              `NUNCA use @aws-sdk/* (DynamoDBClient, etc.) — não funciona no Azure.`)
          : ``;
      }
      session.addUserMessage(
        `Erros TypeScript:\n${result.errors.join('\n')}\n\n` +
        `Corrija e retorne o JSON completo de novo, com TODOS os ${originalFileCount} arquivo(s) da resposta anterior ` +
        `(não só o(s) que tinha(m) erro) — os arquivos que já estavam corretos devem vir de volta sem alteração.` +
        tsHint
      );
      const retryChunks: string[] = [];
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        spinner.succeed('Código corrigido');
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try {
          const retryParsed = extractResponse(retryRaw);
          if (retryParsed.files.length < originalFileCount) {
            console.log(chalk.yellow(
              `  ⚠ a correção devolveu menos arquivos que a resposta original (${retryParsed.files.length} vs ${originalFileCount}) — confira se nada foi perdido.`
            ));
          }
          parsed = retryParsed;
        } catch { /* usa original */ }
      } catch (err) {
        spinner.fail('Erro no retry: ' + (err as Error).message);
      }
    }
  }

  printExplanation(parsed.explanation);
  printWarnings(parsed.warnings);

  // Rastreia o que a IA escreveu em disco para reconciliar órfãos entre as
  // tentativas de auto-correção do loop de synth (ver removeOrphanedGeneratedFiles).
  let previouslyWritten: string[] = [];
  if (parsed.files.length > 0) {
    previouslyWritten = await writeGeneratedFiles(parsed.files, cwd, dryRun, ask);
  }

  printNextSteps(parsed.nextSteps);

  if (!dryRun && parsed.files.length > 0) {
    const MAX_SYNTH_RETRIES = 5;
    let synthOk = false;
    for (let attempt = 1; attempt <= MAX_SYNTH_RETRIES; attempt++) {
      const spinner = ora({ text: `Validando com iacmp synth (tentativa ${attempt}/${MAX_SYNTH_RETRIES})...`, spinner: 'dots', discardStdin: false }).start();
      const { success, output } = runSynthCapture(cwd, iacProvider);
      let correctionMsg: string | null = null;
      if (!success) {
        spinner.fail(`Synth falhou — corrigindo automaticamente...`);
        // "NÃO repita": o modelo às vezes devolve a MESMA geração nas tentativas
        // seguintes (observado 3x no ciclo p01az) — exigir mudança explícita no
        // trecho apontado pelo erro reduz o loop estéril.
        correctionMsg =
          `O comando "iacmp synth" falhou com o seguinte erro:\n\n${output}\n\n` +
          `A geração anterior está ERRADA no ponto apontado acima — NÃO retorne o mesmo código: ` +
          `MUDE especificamente o trecho que causa o erro (tentativa ${attempt} de ${MAX_SYNTH_RETRIES}). ` +
          `Corrija os arquivos e retorne o JSON completo com TODOS os ${parsed.files.length} arquivo(s) da resposta anterior.`;
      } else {
        // Synth passou, mas o loop pode ter reescrito handlers (src/*.ts) sem
        // revalidar TypeScript — um import quebrado (ex: DynamoDBClient vindo de
        // @aws-sdk/lib-dynamodb) só apareceria no build do deploy. Revalida aqui.
        const currentTs = parsed.files.filter(f => f.path.endsWith('.ts'));
        let tsResult = currentTs.length > 0 ? validateTypeScript(currentTs, cwd) : { valid: true, errors: [] };
        if (!tsResult.valid && tryInstallMissingModules(tsResult.errors, cwd, iacProvider, parsed.files)) {
          tsResult = validateTypeScript(currentTs, cwd);
        }
        // SDK errado no Azure tem PRIORIDADE sobre o TS — roda MESMO com TS
        // inválido, porque o SDK errado costuma SER a causa do erro TS (ex:
        // data-tables.getSignedUrl inexistente num cenário de blob). Antes o
        // detector ficava dentro de `if (tsResult.valid)` e o loop travava em
        // deadlock (TS falha → corretor genérico → SDK errado permanece → ...).
        const azureSdkMsg = iacProvider === 'azure' ? buildAzureSdkCorrection(parsed.files) : null;
        if (azureSdkMsg) {
          spinner.fail('Azure: handlers com SDK errado — corrigindo...');
          correctionMsg = azureSdkMsg;
        } else if (tsResult.valid) {
          spinner.succeed('Synth validado');
          synthOk = true;
          break;
        } else {
          spinner.fail('Handler com erro de TypeScript — corrigindo automaticamente...');
          correctionMsg =
            `O synth passou, mas os handlers têm erros de TypeScript (o build do deploy vai falhar):\n\n${tsResult.errors.join('\n')}\n\n` +
            `Corrija e retorne o JSON completo com TODOS os ${parsed.files.length} arquivo(s) da resposta anterior. ` +
            `Lembre: DynamoDBClient vem de '@aws-sdk/client-dynamodb'; GetCommand/PutCommand/QueryCommand/ScanCommand vêm de '@aws-sdk/lib-dynamodb' e exigem DynamoDBDocumentClient.from(new DynamoDBClient({})).`;
        }
      }
      if (attempt === MAX_SYNTH_RETRIES || !correctionMsg) break;
      session.addUserMessage(correctionMsg);
      const retryChunks: string[] = [];
      const retrySpinner = ora({ text: 'Aguardando correção da IA...', spinner: 'dots', discardStdin: false }).start();
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        retrySpinner.succeed('Arquivos corrigidos pela IA');
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try {
          const retryParsed = extractResponse(retryRaw);
          stripProtectedFiles(retryParsed);
          parsed = retryParsed;
          // Cada regeneração SUBSTITUI o conjunto anterior. Escreve a nova geração
          // e, SÓ se ela foi de fato aplicada, remove as stacks/handlers órfãos da
          // tentativa anterior — senão órfãos ficam em stacks/, o synth (que
          // carrega TODAS as .ts) segue vendo constructs duplicados e não converge.
          const written = await writeGeneratedFiles(parsed.files, cwd, false, async () => 'y');
          if (written.length > 0) {
            const orphans = removeOrphanedGeneratedFiles(previouslyWritten, parsed.files, cwd);
            if (orphans.length > 0) {
              console.log(chalk.dim(`  ✗ removidos ${orphans.length} arquivo(s) órfão(s) da tentativa anterior: ${orphans.join(', ')}`));
            }
            previouslyWritten = written;
          }
        } catch { /* mantém parsed anterior */ }
      } catch (err) {
        retrySpinner.fail('Erro no retry: ' + (err as Error).message);
        break;
      }
    }
    if (!synthOk) {
      console.log(chalk.yellow('\n  ⚠ Não foi possível corrigir automaticamente — revise os arquivos gerados.'));
    }
  }

  return parsed;
}

export default class AI extends Command {
  static description = 'Gera stacks de infraestrutura via IA (Claude ou GitHub Copilot)';

  static args = {
    prompt: Args.string({ description: 'Descrição do que criar (obrigatório sem --chat)', required: false }),
  };

  static flags = {
    chat: Flags.boolean({ description: 'Modo chat interativo', default: false }),
    'dry-run': Flags.boolean({ description: 'Gera e exibe sem salvar arquivos', default: false }),
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform)' }),
  };

  static examples = [
    '$ iacmp ai "cria uma Lambda com API Gateway"',
    '$ iacmp ai --chat',
    '$ iacmp ai --dry-run "cria uma VPC com subnets"',
    '$ iacmp ai "migra a stack para azure" --provider azure',
  ];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AI);
    const cwd = process.cwd();
    const dryRun = flags['dry-run'];
    const iacProvider = resolveIaCProvider({ provider: flags.provider }, cwd);

    // Bootstrap silencioso: numa pasta vazia (só .env), cria iacmp.json/tsconfig
    // e instala @iacmp/core + ts-node para que o loop de validação `iacmp synth`
    // funcione. No-op se o projeto já estiver inicializado.
    if (!dryRun) {
      const spinner = ora({ text: 'Preparando projeto...', spinner: 'dots', discardStdin: false }).start();
      try {
        const result = ensureProjectInitialized(cwd, { provider: iacProvider });
        if (result.bootstrapped) spinner.succeed(`Projeto inicializado (${result.created.join(', ')})`);
        else spinner.stop();
      } catch (err) {
        spinner.fail(`Falha ao preparar o projeto: ${(err as Error).message}`);
        this.error('Não foi possível inicializar o projeto automaticamente. Rode `iacmp init` manualmente.');
      }
    }

    if (flags.chat) {
      // Modo chat: spawn de processo filho com stdio herdado — oclif não interfere no stdin
      const chatScript = path.resolve(__dirname, '../../bin/chat.js');
      const child = cp.spawn(process.execPath, [chatScript], {
        stdio: 'inherit',
        env: {
          ...process.env,
          IACMP_CWD: cwd,
          IACMP_PROVIDER: iacProvider,
          IACMP_DRYRUN: dryRun ? '1' : '0',
        },
      });
      await new Promise<void>(resolve => child.on('close', resolve));
      return;
    }

    // Modo direto: prompt único
    if (!args.prompt) {
      this.error('Informe o prompt ou use --chat para modo interativo.\nExemplo: iacmp ai "cria uma Lambda com API Gateway"');
    }

    let aiProvider: AIProvider;
    try {
      aiProvider = resolveAIProvider();
    } catch (err) {
      this.error((err as Error).message);
    }

    const session = new ChatSession();
    const { ask, close } = createDirectAsk();
    let projectContext = readProjectContext(cwd);
    // RAG: enriquece o contexto da geração com conhecimento relevante ao pedido
    // (docs de construct + padrões de plataforma) — em vez de inflar o prompt fixo.
    const ragSpinner = ora({ text: 'Recuperando conhecimento relevante...', spinner: 'dots', discardStdin: false }).start();
    const ragContext = await retrieveGenerationContext(cwd, args.prompt!, buildSystemPrompt(''));
    if (ragContext) {
      projectContext = `${projectContext}\n\n${ragContext}`;
      ragSpinner.succeed('Conhecimento recuperado (RAG)');
    } else {
      ragSpinner.stop();
    }
    const provider = createContextualProvider(aiProvider, projectContext, iacProvider);
    // Quando provider=azure, o prompt pode mencionar SDKs AWS explicitamente (ex: o
    // prompt 04 diz "@aws-sdk/client-s3"). O GPT-4o tende a seguir a instrução do
    // usuário literalmente mesmo com override no system prompt. Sufixo garante que a
    // tradução Azure seja aplicada antes de enviar à IA.
    const finalPrompt = iacProvider === 'azure' && /\@aws-sdk\/|aws-sdk|s3-request-presigner|DynamoDBClient|ScanCommand|PutCommand|GetCommand|DeleteCommand/.test(args.prompt ?? '')
      ? `${args.prompt}\n\n[AZURE OVERRIDE: Este prompt menciona SDKs AWS. NUNCA gere @aws-sdk/* neste projeto Azure. Substituições obrigatórias: S3/presigned-URL → Storage.Bucket + @azure/storage-blob + BlobServiceClient.fromConnectionString + SAS (generateBlobSASQueryParameters); DynamoDB → Database.DynamoDB + @azure/data-tables. Gere TODOS os handlers com SDKs Azure.]`
      : args.prompt!;
    session.addUserMessage(finalPrompt);
    try {
      await runGeneration(provider, session, cwd, dryRun, iacProvider, ask, finalPrompt);
    } finally {
      close();
    }
  }
}
