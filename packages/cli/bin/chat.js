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
  extractResponse, validateTypeScript, writeGeneratedFiles,
  runSynth, readProjectContext, printExplanation, printWarnings,
  printNextSteps, buildSystemPrompt,
  loadSession, saveSession, clearSession, getCached, setCache, clearCache,
} = require('@iacmp/ai');

const cwd = process.env.IACMP_CWD || process.cwd();
const iacProvider = process.env.IACMP_PROVIDER || 'aws';
const dryRun = process.env.IACMP_DRYRUN === '1';

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
  throw new Error('Configure ANTHROPIC_API_KEY no .env do projeto');
}

function createContextualProvider(base, projectContext) {
  const systemPrompt = buildSystemPrompt(projectContext);
  return {
    name: base.name,
    chat: (msgs) => base.chat([{ role: 'system', content: systemPrompt }, ...msgs]),
    stream: (msgs, onChunk) => base.stream([{ role: 'system', content: systemPrompt }, ...msgs], onChunk),
  };
}

async function runGeneration(provider, session, lastPrompt) {
  const cached = getCached(cwd, lastPrompt);
  let raw;

  if (cached) {
    console.log(chalk.dim('  ↩ resposta do cache'));
    raw = cached;
    session.addAssistantMessage(raw);
  } else {
    process.stderr.write(chalk.dim('Gerando...\n'));
    const chunks = [];
    try {
      await provider.stream(session.getMessages(), chunk => chunks.push(chunk));
    } catch (err) {
      process.stderr.write(chalk.red('Erro: ' + err.message + '\n'));
      return;
    }
    raw = chunks.join('');
    session.addAssistantMessage(raw);
    setCache(cwd, lastPrompt, raw);
  }

  let parsed;
  try {
    parsed = extractResponse(raw);
  } catch (err) {
    console.error(chalk.red('Erro ao extrair resposta: ' + err.message));
    return;
  }

  // Valida TypeScript
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    const result = validateTypeScript(tsFiles, cwd);
    if (!result.valid) {
      process.stderr.write(chalk.dim('Validação falhou — corrigindo...\n'));
      session.addUserMessage(`Erros TypeScript:\n${result.errors.join('\n')}\n\nCorrija e retorne o JSON completo.`);
      const retryChunks = [];
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try { parsed = extractResponse(retryRaw); } catch {}
      } catch (err) {
        process.stderr.write(chalk.red('Erro no retry: ' + err.message + '\n'));
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
    const ans = await ask('Quer rodar `iacmp synth` agora? (y/n) ');
    if (ans === 'y') runSynth(cwd, iacProvider);
  }
}

async function main() {
  const previous = loadSession(cwd);
  const session = new ChatSession();
  if (previous.length > 0) {
    for (const msg of previous) {
      if (msg.role === 'user') session.addUserMessage(msg.content);
      else session.addAssistantMessage(msg.content);
    }
    console.log(chalk.dim(`\n  Sessão anterior carregada (${previous.length} mensagens)`));
  }

  console.log(chalk.cyan.bold('\niacmp ai — Modo Chat Interativo'));
  console.log(chalk.dim('Comandos: /sair, /quit — encerra | /limpar — limpa sessão e cache\n'));

  let aiProvider;
  try {
    aiProvider = resolveProvider();
  } catch (err) {
    console.error(chalk.red(err.message));
    rl.close();
    process.exit(1);
  }

  while (true) {
    const input = await ask(chalk.bold('> Você: '));

    if (!input) {
      // EOF ou string vazia — só continua se for TTY
      if (_rlDone) break;
      continue;
    }

    if (input === '/sair' || input === '/quit') {
      console.log(chalk.dim('\nEncerrando chat.'));
      break;
    }

    if (input === '/limpar') {
      session.clear();
      clearSession(cwd);
      clearCache(cwd);
      console.log(chalk.dim('Sessão e cache limpos.\n'));
      continue;
    }

    console.log('');
    session.addUserMessage(input);
    saveSession(cwd, session.getMessages());

    const freshContext = readProjectContext(cwd);
    const provider = createContextualProvider(aiProvider, freshContext);

    await runGeneration(provider, session, input);
    saveSession(cwd, session.getMessages());
    console.log('');
  }

  rl.close();
}

main().catch(err => {
  console.error(chalk.red('Erro: ' + err.message));
  process.exit(1);
});
