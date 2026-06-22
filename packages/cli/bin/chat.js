#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');

// Carrega .env do projeto (sobrescreve env do shell — projeto tem prioridade)
(function loadEnv() {
  const cwd = process.env.IACMP_CWD || process.cwd();
  const envPath = path.resolve(cwd, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = val;
  }
})();

// Resolve @iacmp/* — suporta: global install, monorepo (workspace), link local
const Module = require('module');
const _orig = Module._resolveFilename.bind(Module);
const cliDir = path.resolve(__dirname, '..');
const searchRoots = [cliDir, path.resolve(cliDir, '..', '..')];

Module._resolveFilename = function(req, parent, isMain, opts) {
  if (req.startsWith('@iacmp/')) {
    try { return _orig(req, parent, isMain, opts); } catch {}
    for (const root of searchRoots) {
      try {
        return _orig(req, { id: path.join(root, '_fake.js'), filename: path.join(root, '_fake.js') }, isMain, opts);
      } catch {}
    }
    const pkgName = req.replace('@iacmp/', '');
    const candidates = [
      path.resolve(cliDir, '..', pkgName, 'dist', 'index.js'),
      path.resolve(cliDir, 'node_modules', req, 'dist', 'index.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return _orig(req, parent, isMain, opts);
};

const chalk = require('chalk');
const {
  AnthropicProvider, CopilotProvider, ChatSession,
  extractResponse, validateTypeScript, writeGeneratedFiles, deleteFiles,
  runSynth, readProjectContextRAG, printExplanation, printWarnings,
  printNextSteps, buildSystemPrompt,
  loadSession, saveSession, clearSession, getCached, setCache, clearCache,
  resolveLanguage, SUPPORTED_LANGUAGES, MESSAGES,
  startRecording, transcribeAudio, checkVoicePrerequisites,
} = require('@iacmp/ai');

const cwd = process.env.IACMP_CWD || process.cwd();
const iacProvider = process.env.IACMP_PROVIDER || 'aws';
const dryRun = process.env.IACMP_DRYRUN === '1';

let currentLang = resolveLanguage(process.env.IACMP_LANG);

// --- Sistema de leitura de stdin robusto ---
// Usa rl.on('line') com fila interna — evita ERR_USE_AFTER_CLOSE em pipes
// e mantém stdin aberto em TTY interativo
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY,
  crlfDelay: Infinity,
});

const _lineQueue = [];
const _lineWaiters = [];
let _rlDone = false;

rl.on('line', line => {
  const trimmed = line.trim();
  if (_lineWaiters.length > 0) {
    _lineWaiters.shift()(trimmed);
  } else {
    _lineQueue.push(trimmed);
  }
});

rl.on('close', () => {
  _rlDone = true;
  // Resolve waiters pendentes com string vazia (EOF)
  while (_lineWaiters.length > 0) _lineWaiters.shift()('');
});

function ask(question) {
  process.stdout.write(question);
  return new Promise(resolve => {
    if (_lineQueue.length > 0) {
      resolve(_lineQueue.shift());
    } else if (_rlDone) {
      resolve('');
    } else {
      _lineWaiters.push(resolve);
    }
  });
}
// --- Fim do sistema de stdin ---

function resolveProvider() {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
  if (process.env.GITHUB_TOKEN) return new CopilotProvider(process.env.GITHUB_TOKEN);
  throw new Error(MESSAGES[currentLang].chat.configureKey);
}

function createContextualProvider(base, projectContext, responseLang) {
  const systemPrompt = buildSystemPrompt(projectContext, responseLang);
  return {
    name: base.name,
    chat: (msgs) => base.chat([{ role: 'system', content: systemPrompt }, ...msgs]),
    stream: (msgs, onChunk) => base.stream([{ role: 'system', content: systemPrompt }, ...msgs], onChunk),
  };
}

async function runGeneration(provider, session, lastPrompt, projectContext) {
  const t = MESSAGES[currentLang].chat;
  let acted = false;
  // Chave do cache inclui hash do contexto para evitar resposta stale quando o projeto muda
  const contextHash = projectContext
    ? require('crypto').createHash('md5').update(projectContext).digest('hex').slice(0, 8)
    : '';
  const cacheKey = contextHash ? `${lastPrompt}__ctx:${contextHash}` : lastPrompt;
  const cached = getCached(cwd, cacheKey);
  let raw;
  let fromCache = false;

  if (cached) {
    // Valida antes de usar o cache: só reutiliza se for JSON válido
    try {
      extractResponse(cached);
      process.stderr.write(chalk.dim(t.cachedResponse));
      raw = cached;
      fromCache = true;
      session.addAssistantMessage(raw);
    } catch {
      // Cache contém resposta inválida — descarta e chama o modelo
      clearCache(cwd, cacheKey);
    }
  }

  if (!raw) {
    process.stderr.write(chalk.dim(t.generating));
    const chunks = [];
    try {
      await provider.stream(session.getMessages(), chunk => chunks.push(chunk));
    } catch (err) {
      process.stderr.write(chalk.red(t.errorPrefix + err.message + '\n'));
      process.stderr.write(chalk.dim(t.messageNotSaved));
      return;
    }
    raw = chunks.join('');
    session.addAssistantMessage(raw);
  }

  let parsed;
  try {
    parsed = extractResponse(raw);
  } catch {
    // Resposta conversacional (não é JSON) — exibe como texto e segue
    console.log('\n' + raw.trim() + '\n');
    return true; // assistente respondeu — salva a sessão
  }

  // Só grava no cache depois de confirmar que o parse teve sucesso
  if (!fromCache) {
    setCache(cwd, cacheKey, raw);
  }

  // Valida TypeScript
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    const result = validateTypeScript(tsFiles, cwd);
    if (!result.valid) {
      process.stderr.write(chalk.dim(t.validationFailedRetrying));
      session.addUserMessage(`Erros TypeScript:\n${result.errors.join('\n')}\n\nCorrija e retorne o JSON completo.`);
      const retryChunks = [];
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try { parsed = extractResponse(retryRaw); } catch {}
      } catch (err) {
        process.stderr.write(chalk.red(t.retryError + err.message + '\n'));
      }
    }
  }

  printExplanation(parsed.explanation, currentLang);
  printWarnings(parsed.warnings, currentLang);

  if (parsed.deletions && parsed.deletions.length > 0) {
    await deleteFiles(parsed.deletions, cwd, iacProvider, ask, undefined, currentLang);
    acted = true;
  }

  if (parsed.files.length > 0) {
    await writeGeneratedFiles(parsed.files, cwd, dryRun, ask, currentLang);
    acted = true;
  }

  printNextSteps(parsed.nextSteps, currentLang);
  return true; // assistente respondeu — sempre salva a sessão
}

async function handleVoiceCommand() {
  const t = MESSAGES[currentLang].chat.voice;
  const issue = checkVoicePrerequisites();
  if (issue === 'sox') { console.log(chalk.red(t.soxMissing)); return null; }
  if (issue === 'bin') { console.log(chalk.red(t.binMissing)); return null; }
  if (issue === 'model') { console.log(chalk.red(t.modelMissing)); return null; }

  while (true) {
    console.log(chalk.dim(t.recording));
    const recording = startRecording();
    await ask('');
    await recording.stop();

    let result;
    try {
      result = transcribeAudio(recording.filePath);
    } catch (err) {
      console.log(chalk.red(t.transcribeError(err.message)));
      return null;
    }

    if (!result.text) {
      console.log(chalk.dim(t.empty));
      return null;
    }

    console.log(chalk.bold(t.said(result.language || currentLang, result.text)));
    const confirm = await ask(chalk.dim(t.confirmPrompt));

    if (confirm === '/voz') continue;
    if (confirm === '') return result;
    return { text: confirm, language: result.language };
  }
}

async function main() {
  const previous = loadSession(cwd);
  const session = new ChatSession();
  if (previous.length > 0) {
    // Sessão contaminada: se alguma resposta do modelo dizia "modo standalone"
    // mas agora temos um projeto real, o histórico está errado — descarta.
    const contaminated = previous.some(msg => {
      if (msg.role !== 'assistant') return false;
      try {
        const parsed = JSON.parse(msg.content);
        return typeof parsed.explanation === 'string' &&
          parsed.explanation.toLowerCase().includes('standalone');
      } catch { return false; }
    });

    if (contaminated) {
      clearSession(cwd);
      clearCache(cwd);
      console.log(chalk.dim(MESSAGES[currentLang].chat.sessionDiscarded));
    } else {
      for (const msg of previous) {
        if (msg.role === 'user') session.addUserMessage(msg.content);
        else session.addAssistantMessage(msg.content);
      }
      console.log(chalk.dim(MESSAGES[currentLang].chat.sessionLoaded(previous.length)));
    }
  }

  console.log(chalk.cyan.bold(MESSAGES[currentLang].chat.bannerTitle));
  console.log(chalk.dim(MESSAGES[currentLang].chat.bannerCommands));

  let aiProvider;
  try {
    aiProvider = resolveProvider();
  } catch (err) {
    console.error(chalk.red(err.message));
    rl.close();
    process.exit(1);
  }

  while (true) {
    let input = await ask(chalk.bold(MESSAGES[currentLang].chat.prompt));
    let voiceLanguageForThisTurn = null;

    if (!input) {
      // EOF ou string vazia — só continua se for TTY
      if (_rlDone) break;
      continue;
    }

    if (input === '/sair' || input === '/quit') {
      console.log(chalk.dim(MESSAGES[currentLang].chat.exiting));
      break;
    }

    if (input === '/limpar') {
      session.clear();
      clearSession(cwd);
      clearCache(cwd);
      console.log(chalk.dim(MESSAGES[currentLang].chat.sessionCleared));
      continue;
    }

    if (input === '/lang' || input.startsWith('/lang ')) {
      const arg = input.slice('/lang'.length).trim().toLowerCase();
      if (!arg) {
        console.log(chalk.yellow(MESSAGES[currentLang].chat.langUsage));
        continue;
      }
      if (!SUPPORTED_LANGUAGES.includes(arg)) {
        console.log(chalk.yellow(MESSAGES[currentLang].chat.langInvalid(SUPPORTED_LANGUAGES.join(', '))));
        continue;
      }
      currentLang = arg;
      console.log(chalk.dim(MESSAGES[currentLang].chat.langChanged(currentLang)));
      continue;
    }

    if (input === '/voz') {
      const voiceResult = await handleVoiceCommand();
      console.log('');
      if (!voiceResult) continue;
      input = voiceResult.text;
      voiceLanguageForThisTurn = voiceResult.language;
    }

    console.log('');

    const freshContext = await readProjectContextRAG(cwd, input);

    // Na primeira mensagem da sessão, inclui o contexto das stacks na mensagem
    // para garantir que o modelo leia o estado atual do projeto mesmo com histórico longo
    const isFirstMessage = session.getMessages().length === 0;
    const hasStacks = freshContext.includes('Stacks existentes');
    const userMessageContent = (isFirstMessage && hasStacks)
      ? `${input}\n\n[Contexto do projeto]\n${freshContext}`
      : input;

    session.addUserMessage(userMessageContent);

    const responseLang = voiceLanguageForThisTurn || currentLang;
    const provider = createContextualProvider(aiProvider, freshContext, responseLang);

    const responded = await runGeneration(provider, session, input, freshContext);
    if (responded) {
      saveSession(cwd, session.getMessages());
    } else {
      // Erro na geração — remove a mensagem do usuário para não deixar sessão malformada
      session.removeLast();
    }
    console.log('');
  }

  rl.close();
}

main().catch(err => {
  console.error(chalk.red(MESSAGES[currentLang].chat.errorPrefix + err.message));
  process.exit(1);
});
