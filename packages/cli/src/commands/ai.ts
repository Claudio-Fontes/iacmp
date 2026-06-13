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

async function runGeneration(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  dryRun: boolean,
  iacProvider: string,
  rl: readline.Interface,
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
    await writeGeneratedFiles(parsed.files, cwd, dryRun, rl);
  }

  printNextSteps(parsed.nextSteps);

  if (!dryRun && parsed.files.length > 0) {
    const answer = await new Promise<string>(resolve =>
      rl.question('Quer rodar `iacmp synth` agora? (y/n) ', ans => resolve(ans.trim()))
    );
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

    if (flags.chat) {
      await this.runChatMode(aiProvider, session, cwd, dryRun, iacProvider);
    } else {
      if (!args.prompt) {
        this.error('Informe o prompt ou use --chat para modo interativo.\nExemplo: iacmp ai "cria uma Lambda com API Gateway"');
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const projectContext = readProjectContext(cwd);
      const provider = createContextualProvider(aiProvider, projectContext);
      session.addUserMessage(args.prompt);
      await runGeneration(provider, session, cwd, dryRun, iacProvider, rl, args.prompt);
      rl.close();
    }
  }

  private async runChatMode(
    aiProvider: AIProvider,
    session: ChatSession,
    cwd: string,
    dryRun: boolean,
    iacProvider: string
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

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const askLine = (): Promise<string> =>
      new Promise(resolve => rl.question(chalk.bold('> Você: '), resolve));

    while (true) {
      let input: string;
      try {
        input = (await askLine()).trim();
      } catch {
        break;
      }

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

      // Salva sessão após cada mensagem do usuário
      saveSession(cwd, session.getMessages());

      // Reler contexto a cada turno — captura arquivos gerados nesta sessão
      const freshContext = readProjectContext(cwd);
      const freshProvider = createContextualProvider(aiProvider, freshContext);

      await runGeneration(freshProvider, session, cwd, dryRun, iacProvider, rl, input);

      // Salva sessão após resposta da IA
      saveSession(cwd, session.getMessages());

      console.log('');
    }

    rl.close();
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
