import { Command, Args, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import {
  AIProvider,
  AnthropicProvider,
  CopilotProvider,
  ChatSession,
  extractResponse,
  validateTypeScript,
  writeGeneratedFiles,
  runSynth,
  readProjectContext,
  printExplanation,
  printWarnings,
  printNextSteps,
  buildSystemPrompt,
  AIGeneratedResponse,
  loadSession,
  saveSession,
  clearSession,
  getCached,
  setCache,
  clearCache,
} from '@iacmp/ai';

// Função de leitura centralizada — único consumidor de stdin
type AskFn = (question: string) => Promise<string>;

function resolveAIProvider(): AIProvider {
  if (process.env['ANTHROPIC_API_KEY']) {
    return new AnthropicProvider(process.env['ANTHROPIC_API_KEY']);
  }
  if (process.env['GITHUB_TOKEN']) {
    return new CopilotProvider(process.env['GITHUB_TOKEN']);
  }
  throw new Error(
    'Configure ANTHROPIC_API_KEY ou GITHUB_TOKEN para usar iacmp ai\n' +
    '  export ANTHROPIC_API_KEY=sk-ant-...\n' +
    '  ou\n' +
    '  export GITHUB_TOKEN=ghp_...'
  );
}

function resolveIaCProvider(flags: { provider?: string }, cwd: string): string {
  if (flags.provider) return flags.provider;
  const configPath = path.join(cwd, 'iacmp.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (typeof config['provider'] === 'string') return config['provider'];
    } catch {
      // ignora
    }
  }
  return 'aws';
}

// Cria um leitor de linha serializado — garante que só uma pergunta está ativa por vez
function createAskFn(): { ask: AskFn; close: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY,
  });

  // Fila de perguntas — processa uma por vez
  const queue: Array<{ question: string; resolve: (answer: string) => void }> = [];
  let busy = false;

  function next() {
    if (busy || queue.length === 0) return;
    busy = true;
    const { question, resolve } = queue.shift()!;
    rl.question(question, answer => {
      busy = false;
      resolve(answer.trim());
      next();
    });
  }

  const ask: AskFn = (question: string) =>
    new Promise(resolve => {
      queue.push({ question, resolve });
      next();
    });

  return { ask, close: () => rl.close() };
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
  const rawChunks: string[] = [];

  // Verifica cache antes de chamar a API
  const cached = getCached(cwd, lastUserPrompt);
  let raw: string;

  if (cached) {
    console.log(chalk.dim('  ↩ resposta do cache'));
    raw = cached;
    session.addAssistantMessage(raw);
  } else {
    const spinner = ora({ text: 'Gerando...', spinner: 'dots' }).start();

    try {
      await provider.stream(session.getMessages(), chunk => {
        rawChunks.push(chunk);
      });
    } catch (err) {
      spinner.fail('Erro ao chamar a IA: ' + (err as Error).message);
      return null;
    }

    spinner.succeed('Resposta recebida');
    raw = rawChunks.join('');
    session.addAssistantMessage(raw);
    setCache(cwd, lastUserPrompt, raw);
  }

  let parsed: AIGeneratedResponse;
  try {
    parsed = extractResponse(raw);
  } catch (err) {
    console.error(chalk.red('Erro ao extrair resposta da IA: ' + (err as Error).message));
    return null;
  }

  // Valida TypeScript se houver arquivos .ts
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    const result = validateTypeScript(tsFiles, cwd);
    if (!result.valid) {
      const retrySpinner = ora({ text: 'Validação TypeScript falhou — corrigindo...', spinner: 'dots' }).start();
      const errorMsg = result.errors.join('\n');
      session.addUserMessage(
        `O código gerado tem erros TypeScript. Corrija e retorne o JSON completo novamente:\n${errorMsg}`
      );

      const retryChunks: string[] = [];
      try {
        await provider.stream(session.getMessages(), chunk => {
          retryChunks.push(chunk);
        });
      } catch (err) {
        retrySpinner.fail('Erro no retry: ' + (err as Error).message);
        return parsed;
      }

      retrySpinner.succeed('Código corrigido');
      const retryRaw = retryChunks.join('');
      session.addAssistantMessage(retryRaw);

      try {
        parsed = extractResponse(retryRaw);
      } catch {
        // usa o original
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
    const answer = await ask('Quer rodar `iacmp synth` agora? (y/n) ');
    if (answer === 'y') {
      runSynth(cwd, iacProvider);
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
    chat: Flags.boolean({
      description: 'Modo chat interativo',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: 'Gera e exibe sem salvar arquivos',
      default: false,
    }),
    provider: Flags.string({
      char: 'p',
      description: 'Provider alvo (aws, azure, gcp, terraform)',
    }),
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

    let aiProvider: AIProvider;
    try {
      aiProvider = resolveAIProvider();
    } catch (err) {
      this.error((err as Error).message);
    }

    const session = new ChatSession();
    const { ask, close } = createAskFn();

    if (flags.chat) {
      await this.runChatMode(aiProvider, session, cwd, dryRun, iacProvider, ask);
    } else {
      if (!args.prompt) {
        this.error('Informe o prompt ou use --chat para modo interativo.\nExemplo: iacmp ai "cria uma Lambda com API Gateway"');
      }
      const projectContext = readProjectContext(cwd);
      const provider = createContextualProvider(aiProvider, projectContext);
      session.addUserMessage(args.prompt);
      await runGeneration(provider, session, cwd, dryRun, iacProvider, ask, args.prompt);
    }

    close();
  }

  private async runChatMode(
    aiProvider: AIProvider,
    session: ChatSession,
    cwd: string,
    dryRun: boolean,
    iacProvider: string,
    ask: AskFn
  ): Promise<void> {
    // Carrega sessão anterior
    const previousMessages = loadSession(cwd);
    if (previousMessages.length > 0) {
      for (const msg of previousMessages) {
        if (msg.role === 'user') session.addUserMessage(msg.content);
        else session.addAssistantMessage(msg.content);
      }
      console.log(chalk.dim(`\n  Sessão anterior carregada (${previousMessages.length} mensagens)`));
    }

    console.log(chalk.cyan.bold('\niacmp ai — Modo Chat Interativo'));
    console.log(chalk.dim('Comandos: /sair, /quit — encerra | /limpar — limpa sessão e cache\n'));

    while (true) {
      const input = await ask(chalk.bold('> Você: '));

      if (!input) continue;

      if (input === '/sair' || input === '/quit') {
        console.log(chalk.dim('Encerrando chat.'));
        break;
      }

      if (input === '/limpar') {
        session.clear();
        clearSession(cwd);
        clearCache(cwd);
        console.log(chalk.dim('Sessão e cache limpos.\n'));
        continue;
      }

      session.addUserMessage(input);
      saveSession(cwd, session.getMessages());

      // Reler contexto a cada turno — captura arquivos gerados nesta sessão
      const freshContext = readProjectContext(cwd);
      const freshProvider = createContextualProvider(aiProvider, freshContext);

      await runGeneration(freshProvider, session, cwd, dryRun, iacProvider, ask, input);

      saveSession(cwd, session.getMessages());

      console.log('');
    }
  }
}

function createContextualProvider(base: AIProvider, projectContext: string): AIProvider {
  const systemPrompt = buildSystemPrompt(projectContext);

  return {
    name: base.name,
    async chat(messages) {
      const withContext = [{ role: 'system' as const, content: systemPrompt }, ...messages];
      return base.chat(withContext);
    },
    async stream(messages, onChunk) {
      const withContext = [{ role: 'system' as const, content: systemPrompt }, ...messages];
      return base.stream(withContext, onChunk);
    },
  };
}
