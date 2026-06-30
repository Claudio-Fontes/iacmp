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
  `5. REFERÊNCIAS: env vars de banco usam o id real do Database (ex: AppDB.Endpoint); rotas usam os lambdaId reais.\n\n` +
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
    const results = retrieve(indexes, prompt, { projectK: 0, sourceK: 0, docsK: 4, knowledgeK: 6 });
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

function createContextualProvider(base: AIProvider, projectContext: string): AIProvider {
  const systemPrompt = buildSystemPrompt(projectContext);
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
      const missingModules = result.errors
        .map(e => e.match(/Cannot find module '([^']+)'/))
        .filter(Boolean)
        .map(m => m![1])
        .filter(pkg => !pkg.startsWith('.') && !pkg.startsWith('@iacmp/'))
        .filter((v, i, a) => a.indexOf(v) === i);

      if (missingModules.length > 0) {
        const installSpinner = ora({ text: `Instalando dependências: ${missingModules.join(', ')}...`, spinner: 'dots', discardStdin: false }).start();
        try {
          cp.execSync(`npm install ${missingModules.join(' ')}`, { cwd, stdio: 'pipe' });
          installSpinner.succeed(`Instalado: ${missingModules.join(', ')}`);
          result = validateTypeScript(tsFiles, cwd);
        } catch (installErr) {
          installSpinner.fail(`Falha ao instalar ${missingModules.join(', ')}`);
        }
      }
    }

    if (!result.valid) {
      const spinner = ora({ text: 'Validação TypeScript falhou — corrigindo...', spinner: 'dots', discardStdin: false }).start();
      const originalFileCount = parsed.files.length;
      session.addUserMessage(
        `Erros TypeScript:\n${result.errors.join('\n')}\n\n` +
        `Corrija e retorne o JSON completo de novo, com TODOS os ${originalFileCount} arquivo(s) da resposta anterior ` +
        `(não só o(s) que tinha(m) erro) — os arquivos que já estavam corretos devem vir de volta sem alteração.`
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

  if (parsed.files.length > 0) {
    await writeGeneratedFiles(parsed.files, cwd, dryRun, ask);
  }

  printNextSteps(parsed.nextSteps);

  if (!dryRun && parsed.files.length > 0) {
    const MAX_SYNTH_RETRIES = 5;
    let synthOk = false;
    for (let attempt = 1; attempt <= MAX_SYNTH_RETRIES; attempt++) {
      const spinner = ora({ text: `Validando com iacmp synth (tentativa ${attempt}/${MAX_SYNTH_RETRIES})...`, spinner: 'dots', discardStdin: false }).start();
      const { success, output } = runSynthCapture(cwd, iacProvider);
      if (success) {
        spinner.succeed('Synth validado');
        synthOk = true;
        break;
      }
      spinner.fail(`Synth falhou — corrigindo automaticamente...`);
      if (attempt === MAX_SYNTH_RETRIES) break;
      const originalFileCount = parsed.files.length;
      session.addUserMessage(
        `O comando "iacmp synth" falhou com o seguinte erro:\n\n${output}\n\n` +
        `Corrija os arquivos e retorne o JSON completo com TODOS os ${originalFileCount} arquivo(s) da resposta anterior.`
      );
      const retryChunks: string[] = [];
      const retrySpinner = ora({ text: 'Aguardando correção da IA...', spinner: 'dots', discardStdin: false }).start();
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        retrySpinner.succeed('Arquivos corrigidos pela IA');
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try {
          const retryParsed = extractResponse(retryRaw);
          parsed = retryParsed;
          await writeGeneratedFiles(parsed.files, cwd, false, async () => 'y');
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
    const provider = createContextualProvider(aiProvider, projectContext);
    session.addUserMessage(args.prompt);
    try {
      await runGeneration(provider, session, cwd, dryRun, iacProvider, ask, args.prompt);
    } finally {
      close();
    }
  }
}
