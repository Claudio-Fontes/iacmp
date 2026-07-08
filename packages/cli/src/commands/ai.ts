import { Command, Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import ora from 'ora';
import {
  AIProvider,
  AnthropicProvider,
  OpenAIProvider,
  CopilotProvider,
  ChatSession,
  readProjectContext,
  readProjectMeta,
  buildSystemPrompt,
  buildIndexes,
  retrieve,
  formatRetrievedContext,
  searchKnowledgeBase,
} from '@iacmp/ai';
import { ensureProjectInitialized } from '../bootstrap';
import { runGeneration, AskFn } from '../generation';

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
    // RAG: quando retorna hits, usa só o meta (lista de stacks) + chunks relevantes.
    // Sem RAG: fallback para readProjectContext (conteúdo completo).
    // Isso evita injetar o conteúdo completo de todas as stacks + RAG ao mesmo tempo
    // (causava 429 Request too large no gpt-4o com limite de 30k TPM).
    const ragSpinner = ora({ text: 'Recuperando conhecimento relevante...', spinner: 'dots', discardStdin: false }).start();
    const ragContext = await retrieveGenerationContext(cwd, args.prompt!, buildSystemPrompt(''));
    let projectContext: string;
    if (ragContext) {
      projectContext = `${readProjectMeta(cwd)}\n\n${ragContext}`;
      ragSpinner.succeed('Conhecimento recuperado (RAG)');
    } else {
      projectContext = readProjectContext(cwd);
      ragSpinner.stop();
    }
    // Knowledge base: injeta exemplos validados do banco ~/.iacmp/knowledge.db (BM25).
    // Só entra quando o banco existe — falha graciosamente caso contrário.
    const kbSpinner = ora({ text: 'Consultando knowledge base...', spinner: 'dots', discardStdin: false }).start();
    const kbExamples = searchKnowledgeBase(args.prompt!, iacProvider);
    if (kbExamples) {
      projectContext = `${kbExamples}\n\n${projectContext}`;
      kbSpinner.succeed(`Knowledge base: exemplos relevantes encontrados`);
    } else {
      kbSpinner.stop();
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
