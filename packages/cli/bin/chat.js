#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

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
  AnthropicProvider, OpenAIProvider, CopilotProvider, ChatSession,
  extractResponse, validateTypeScript, writeGeneratedFiles, deleteFiles,
  runSynth, runSynthCapture, readProjectContextRAG, printExplanation, printWarnings,
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

const _lineQueue = [];   // fila de mensagens completas (já agrupadas)
const _lineWaiters = [];
let _rlDone = false;

// Agrupamento de paste: linhas que chegam dentro de PASTE_WINDOW_MS
// são combinadas em uma única mensagem. Resolve o problema de prompts
// multi-linha colados no terminal (readline dispara line por line).
const PASTE_WINDOW_MS = 40;
let _pendingLines = [];
let _pasteTimer = null;

function _flushPending() {
  _pasteTimer = null;
  if (_pendingLines.length === 0) return;
  const combined = _pendingLines.join('\n').trim();
  _pendingLines = [];
  if (!combined) return;
  if (_lineWaiters.length > 0) {
    _lineWaiters.shift()(combined);
  } else {
    _lineQueue.push(combined);
  }
}

rl.on('line', line => {
  _pendingLines.push(line);
  if (_pasteTimer) clearTimeout(_pasteTimer);
  _pasteTimer = setTimeout(_flushPending, PASTE_WINDOW_MS);
});

rl.on('close', () => {
  if (_pasteTimer) { clearTimeout(_pasteTimer); _flushPending(); }
  _rlDone = true;
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
  const model = process.env.IACMP_MODEL;
  const preferred = (process.env.IACMP_PROVIDER_AI || '').toLowerCase();

  if (preferred === 'openai' && process.env.OPENAI_API_KEY) return new OpenAIProvider(process.env.OPENAI_API_KEY, model);
  if (preferred === 'anthropic' && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, model);
  if (preferred === 'copilot' && process.env.GITHUB_TOKEN) return new CopilotProvider(process.env.GITHUB_TOKEN);
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicProvider(process.env.ANTHROPIC_API_KEY, model);
  if (process.env.OPENAI_API_KEY) return new OpenAIProvider(process.env.OPENAI_API_KEY, model);
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
    let accumulated = '';
    const announced = new Set();
    try {
      await provider.stream(session.getMessages(), chunk => {
        chunks.push(chunk);
        accumulated += chunk;
        const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
        let m;
        while ((m = pathRegex.exec(accumulated)) !== null) {
          if (!announced.has(m[1])) {
            announced.add(m[1]);
            process.stderr.write(chalk.dim(`  → ${m[1]}\n`));
          }
        }
      });
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

  // Arquivos de projeto/ambiente são do bootstrap, NÃO da IA. Quando a IA
  // reescreve package.json, clobbera o link do @iacmp/core e remove
  // ts-node/typescript — e o synth para de carregar as stacks. Descarta esses.
  const PROTECTED_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'iacmp.json', '.env', '.gitignore']);
  const dropped = parsed.files.filter(f => PROTECTED_FILES.has(f.path.split('/').pop()));
  if (dropped.length > 0) {
    parsed.files = parsed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop()));
    process.stderr.write(`  (ignorando ${dropped.map(f => f.path).join(', ')} — gerenciados pelo projeto, não pela IA)\n`);
  }

  // ── Auto-revisão semântica ────────────────────────────────────────────────
  // A IA revisa a própria resposta contra o pedido (construct certo, CRUD
  // completo, schema/SQL), pegando erros de intenção que TS/synth não pegam.
  if (!fromCache && parsed.files.length > 0) {
    process.stderr.write('Auto-revisão da geração...\n');
    const reviewPrompt =
      `Antes de finalizar, revise sua resposta anterior como um engenheiro sênior revisando um Pull Request, comparando-a com o pedido ORIGINAL. Verifique CADA item:\n` +
      `1. REQUISITOS: todo requisito explícito do pedido está implementado?\n` +
      `1b. SEPARAÇÃO POR CAMADA: recursos divididos em múltiplas stacks (network/database/compute/security), NÃO tudo num arquivo só? Se VPC+banco+lambdas+secret estão juntos, SEPARE.\n` +
      `2. PONTO DE ENTRADA HTTP (crítico): "API REST/HTTP" servida por Lambdas EXIGE um Fn.ApiGateway com routes[] apontando para cada lambdaId. Se NENHUM arquivo tiver Fn.ApiGateway, CRIE stacks/network/api-gateway-stack.ts com Fn.ApiGateway (type: 'HTTP', cors: true, uma rota por método). NUNCA use Network.LoadBalancer.\n` +
      `3. CRUD COMPLETO: listar/obter/criar/atualizar/deletar existem e wireadas nas rotas.\n` +
      `4. SCHEMA E SQL: tabela com TODOS os campos da spec; handler de listagem cria a tabela (CREATE TABLE IF NOT EXISTS) com todos os campos; INSERT/UPDATE leem/escrevem todos; contagem de colunas BATE com a de valores; SQL parametrizado.\n` +
      `5. REFERÊNCIAS: env vars de banco usam o id real do Database (ex: AppDB.Endpoint); rotas usam lambdaId reais.\n\n` +
      `Se houver QUALQUER defeito, retorne o JSON COMPLETO CORRIGIDO com os ${parsed.files.length} arquivo(s). Se estiver perfeito, retorne o mesmo JSON. Responda APENAS com o JSON.`;
    session.addUserMessage(reviewPrompt);
    const reviewChunks = [];
    try {
      await provider.stream(session.getMessages(), chunk => reviewChunks.push(chunk));
      const reviewRaw = reviewChunks.join('');
      session.addAssistantMessage(reviewRaw);
      try {
        const reviewed = extractResponse(reviewRaw);
        if (reviewed.files && reviewed.files.length > 0) {
          reviewed.files = reviewed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop()));
          // MERGE por path — arquivos da geração original não citados pela
          // revisão são mantidos (senão a revisão poderia dropar stacks).
          const byPath = new Map(parsed.files.map(f => [f.path, f]));
          for (const f of reviewed.files) byPath.set(f.path, f);
          reviewed.files = [...byPath.values()];
          parsed = reviewed;
        }
      } catch { /* revisão não retornou JSON — mantém o original */ }
    } catch (err) {
      process.stderr.write('  (auto-revisão falhou, seguindo com a geração original)\n');
    }
  }

  // Valida TypeScript
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length > 0) {
    let result = validateTypeScript(tsFiles, cwd);

    // Auto-instala pacotes faltantes antes de mandar pra IA corrigir
    if (!result.valid) {
      const missingModules = result.errors
        .map(e => e.match(/Cannot find module '([^']+)'/))
        .filter(Boolean)
        .map(m => m[1])
        .filter(pkg => !pkg.startsWith('.') && !pkg.startsWith('@iacmp/'))
        .filter((v, i, a) => a.indexOf(v) === i);

      if (missingModules.length > 0) {
        process.stderr.write(chalk.dim(`Instalando: ${missingModules.join(', ')}...\n`));
        try {
          cp.execSync(`npm install ${missingModules.join(' ')}`, { cwd, stdio: 'pipe' });
          process.stderr.write(chalk.green(`✓ Instalado: ${missingModules.join(', ')}\n`));
          result = validateTypeScript(tsFiles, cwd);
        } catch {
          process.stderr.write(chalk.red(`✗ Falha ao instalar: ${missingModules.join(', ')}\n`));
        }
      }
    }

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
    // Descarta linhas residuais do paste que ficaram na fila —
    // sem isso, o confirm "Aplicar mudanças? [y/n]" consome essas
    // sobras em vez de esperar o y/n real do usuário.
    while (_lineQueue.length > 0) _lineQueue.shift();
    await writeGeneratedFiles(parsed.files, cwd, dryRun, ask, currentLang);
    acted = true;

    // Após aplicar os arquivos, detecta e instala pacotes referenciados nos
    // arquivos TS gerados (import ou require) que não estão em node_modules.
    // Cobre o caso em que a IA usa require() as any — TypeScript não reclama,
    // mas o pacote precisa estar instalado para build/deploy funcionar.
    const generatedTs = parsed.files.filter(f => f.path.endsWith('.ts') || f.path.endsWith('.js'));
    const pkgPattern = /(?:import\s+.*?\s+from\s+['"]([^'"./][^'"]*?)['"]|require\(['"]([^'"./][^'"]*?)['"]\))/g;
    const builtins = new Set(['fs', 'path', 'https', 'http', 'url', 'crypto', 'os', 'stream', 'util', 'events', 'buffer', 'child_process', 'readline', 'net', 'tls', 'zlib', 'assert', 'querystring', 'string_decoder', 'timers', 'vm']);
    const toInstall = new Set();
    for (const file of generatedTs) {
      let m;
      pkgPattern.lastIndex = 0;
      while ((m = pkgPattern.exec(file.content)) !== null) {
        const pkg = (m[1] || m[2]).split('/').slice(0, m[1]?.startsWith('@') || m[2]?.startsWith('@') ? 2 : 1).join('/');
        if (!builtins.has(pkg) && !pkg.startsWith('@iacmp/')) {
          const nodeModulesPath = path.join(cwd, 'node_modules', pkg);
          if (!fs.existsSync(nodeModulesPath)) toInstall.add(pkg);
        }
      }
    }
    if (toInstall.size > 0) {
      const pkgs = [...toInstall];
      process.stdout.write(`\nInstalando dependências: ${pkgs.join(', ')}...\n`);
      try {
        cp.execSync(`npm install ${pkgs.join(' ')}`, { cwd, stdio: 'inherit' });
        process.stdout.write(`✓ Instalado: ${pkgs.join(', ')}\n\n`);
      } catch (err) {
        process.stdout.write(`✗ Falha ao instalar ${pkgs.join(', ')}: ${err.message}\n\n`);
      }
    }
  }

  printNextSteps(parsed.nextSteps, currentLang);

  if (!dryRun && parsed.files.length > 0) {
    const MAX_SYNTH_RETRIES = 5;
    let synthOk = false;
    for (let attempt = 1; attempt <= MAX_SYNTH_RETRIES; attempt++) {
      process.stderr.write(chalk.dim(`  → Validando synth (${attempt}/${MAX_SYNTH_RETRIES})...\n`));
      const { success, output } = runSynthCapture(cwd, iacProvider);
      if (success) {
        process.stderr.write(chalk.green('  ✓ Synth validado\n'));
        synthOk = true;
        break;
      }
      process.stderr.write(chalk.yellow(`  ✗ Synth falhou — corrigindo automaticamente...\n`));
      if (attempt === MAX_SYNTH_RETRIES) break;
      const originalFileCount = parsed.files.length;
      session.addUserMessage(
        `O comando "iacmp synth" falhou com o seguinte erro:\n\n${output}\n\n` +
        `Corrija os arquivos e retorne o JSON completo com TODOS os ${originalFileCount} arquivo(s) da resposta anterior.`
      );
      const retryChunks = [];
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try {
          const retryParsed = extractResponse(retryRaw);
          parsed = retryParsed;
          await writeGeneratedFiles(parsed.files, cwd, false, async () => 'y', currentLang);
        } catch { /* mantém parsed anterior */ }
      } catch (err) {
        process.stderr.write(chalk.red(`  ✗ Erro no retry: ${err.message}\n`));
        break;
      }
    }
    if (!synthOk) {
      process.stdout.write(chalk.yellow('\n  ⚠ Não foi possível corrigir automaticamente — revise os arquivos gerados.\n'));
    }
  }

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

function autoInitProject() {
  const iacmpConfig = path.join(cwd, 'iacmp.json');
  if (fs.existsSync(iacmpConfig)) return;

  const projectName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');

  fs.writeFileSync(iacmpConfig, JSON.stringify({
    name: projectName,
    provider: 'aws',
    region: 'us-east-1',
  }, null, 2) + '\n', 'utf-8');

  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        ignoreDeprecations: '5.0',
        lib: ['es2022'],
        strict: false,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    }, null, 2) + '\n', 'utf-8');
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: projectName,
      version: '1.0.0',
      private: true,
      scripts: { build: 'tsc', synth: 'iacmp synth', deploy: 'iacmp deploy' },
      dependencies: {},
      devDependencies: {
        typescript: '^5',
        'ts-node': '^10',
        '@iacmp/core': '*',
      },
    }, null, 2) + '\n', 'utf-8');
  }

  console.log(chalk.dim(`  Projeto inicializado: ${iacmpConfig}\n`));
}

async function main() {
  autoInitProject();
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
