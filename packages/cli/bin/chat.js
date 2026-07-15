#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

// Carrega um arquivo no formato key=value para process.env
function loadEnvFile(filePath, overwrite) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (overwrite || process.env[key] === undefined) process.env[key] = val;
  }
}

// Ordem de prioridade (menor → maior) — mesma semântica do env-loader.ts:
// 1. ~/.iacmp/config — defaults globais; NÃO sobrescreve env exportado no shell
// 2. .env do projeto — sobrescreve shell e global (projeto tem prioridade)
(function loadEnv() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  loadEnvFile(path.join(home, '.iacmp', 'config'), false);
  const cwd = process.env.IACMP_CWD || process.cwd();
  loadEnvFile(path.resolve(cwd, '.env'), true);
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
  extractResponse, validateTypeScript, writeGeneratedFiles, deleteFiles, removeOrphanedGeneratedFiles,
  runSynth, runSynthCapture, readProjectContextRAG, printExplanation, printWarnings,
  printNextSteps, buildSystemPrompt,
  loadSession, saveSession, clearSession, getCached, setCache, clearCache, invalidateIndexCache,
  resolveLanguage, SUPPORTED_LANGUAGES, MESSAGES,
  startRecording, transcribeAudio, checkVoicePrerequisites,
  enrichPrompt,
} = require('@iacmp/ai');

const cwd = process.env.IACMP_CWD || process.cwd();
const iacProvider = process.env.IACMP_PROVIDER || 'aws';
const dryRun = process.env.IACMP_DRYRUN === '1';

function extractConstructSignatures(files) {
  const sigs = new Set();
  for (const f of files.filter(f => f.path.startsWith('stacks/'))) {
    if (/eventNotifications\s*:/.test(f.content)) sigs.add('__eventNotifications__');
    if (/eventSources\s*:/.test(f.content)) sigs.add('__eventSources__');
    if (/\bref\s*\(/.test(f.content)) sigs.add('__ref__');
  }
  return sigs;
}

function buildIntegrityWarning(removed, fileCount) {
  const constructs = removed.filter(s => !s.startsWith('__'));
  const connections = removed.filter(s => s.startsWith('__'));
  const lines = ['AVISO CRÍTICO: a correção anterior REMOVEU elementos que estavam na geração original.'];
  if (constructs.length > 0) lines.push(`Constructs removidos: ${constructs.join(', ')}`);
  if (connections.includes('__eventNotifications__')) lines.push('Conexão eventNotifications (trigger S3→SNS/Lambda) foi removida');
  if (connections.includes('__eventSources__')) lines.push('Conexão eventSources foi removida');
  if (connections.includes('__ref__')) lines.push('Referências cross-stack ref() foram substituídas por strings hardcoded');
  lines.push('');
  lines.push('OBRIGATÓRIO: restaure TODOS os elementos listados acima.');
  lines.push('NÃO remova constructs ou conexões para resolver erros de synth — corrija o erro mantendo a arquitetura completa.');
  lines.push(`Retorne o JSON com todos os ${fileCount} arquivo(s) e os elementos restaurados.`);
  return lines.join('\n');
}

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

const CHAT_COMMANDS = new Set(['/sair', '/quit', '/limpar', '/voz']);

function _flushPending() {
  _pasteTimer = null;
  if (_pendingLines.length === 0) return;
  // Filtra linhas que são comandos standalone (ex: /sair colado junto ao prompt via pipe)
  // para evitar que vaze para o contexto do modelo.
  const commandLines = _pendingLines.filter(l => {
    const t = l.trim();
    return CHAT_COMMANDS.has(t) || t === '' || t.startsWith('/lang ');
  });
  const contentLines = _pendingLines.filter(l => {
    const t = l.trim();
    return !CHAT_COMMANDS.has(t) && !t.startsWith('/lang ');
  });
  _pendingLines = [];
  // Enfileira comandos primeiro (vão ser processados em turns futuros), depois conteúdo
  for (const cmd of commandLines) {
    const t = cmd.trim();
    if (!t) continue;
    _lineQueue.push(t);
  }
  const combined = contentLines.join('\n').trim();
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
  const systemPrompt = buildSystemPrompt(projectContext, responseLang, iacProvider);
  return {
    name: base.name,
    chat: (msgs) => base.chat([{ role: 'system', content: systemPrompt }, ...msgs]),
    stream: (msgs, onChunk) => base.stream([{ role: 'system', content: systemPrompt }, ...msgs], onChunk),
  };
}

// Cria um provider de revisão. Se IACMP_MODEL_REVIEW estiver definido, usa esse
// modelo (ex: gpt-4.1 para revisão mais rápida enquanto gpt-5 gera). Caso
// contrário, usa o mesmo modelo da geração com temperatura 0.
function createReviewProvider(base, projectContext, responseLang) {
  const reviewModel = process.env.IACMP_MODEL_REVIEW;
  let reviewBase = base;
  if (reviewModel) {
    if (base.name === 'openai' && process.env.OPENAI_API_KEY) {
      reviewBase = new OpenAIProvider(process.env.OPENAI_API_KEY, reviewModel, 0);
    } else if (base.name === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      reviewBase = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, reviewModel, 0);
    }
  } else {
    if (base.name === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      reviewBase = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, process.env.IACMP_MODEL, 0);
    } else if (base.name === 'openai' && process.env.OPENAI_API_KEY) {
      reviewBase = new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.IACMP_MODEL, 0);
    }
  }
  return createContextualProvider(reviewBase, projectContext, responseLang);
}

async function runGeneration(provider, session, lastPrompt, projectContext, aiProvider, responseLang) {
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
    const genStart = Date.now();
    let genFirstChunk = false;
    process.stderr.write(chalk.dim(t.generating));
    const genTimer = setInterval(() => {
      if (!genFirstChunk) {
        const secs = Math.floor((Date.now() - genStart) / 1000);
        process.stderr.write(chalk.dim(`\r  Aguardando modelo... (${secs}s) `));
      }
    }, 1000);
    const chunks = [];
    let accumulated = '';
    const announced = new Set();
    try {
      await provider.stream(session.getMessages(), chunk => {
        if (!genFirstChunk) {
          genFirstChunk = true;
          process.stderr.write(chalk.dim('\r' + t.generating + '          \n'));
        }
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
      clearInterval(genTimer);
      process.stderr.write(chalk.red('\n' + t.errorPrefix + err.message + '\n'));
      if (/429|quota|rate.?limit|529|503|overload/i.test(err.message)) {
        process.stderr.write(chalk.dim('  Sessão mantida — seu pedido está preservado. Pressione Enter para tentar novamente.\n'));
        return 'retry';
      }
      process.stderr.write(chalk.dim(t.messageNotSaved));
      return;
    }
    clearInterval(genTimer);
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
  // Usa temperatura 0 para reduzir viés de confirmação — o modelo tende a
  // validar a própria saída quando revisa com temperatura alta.
  if (!fromCache && parsed.files.length > 0) {
    process.stderr.write('Auto-revisão da geração...\n');
    const reviewPrompt =
      `Antes de finalizar, revise sua resposta anterior como um engenheiro sênior revisando um Pull Request, comparando-a com o pedido ORIGINAL. Verifique CADA item:\n` +
      `1. REQUISITOS: todo requisito explícito do pedido está implementado?\n` +
      `1b. SEPARAÇÃO POR CAMADA: recursos divididos em múltiplas stacks (network/database/compute/security), NÃO tudo num arquivo só? Se VPC+banco+lambdas+secret estão juntos, SEPARE.\n` +
      `2. PONTO DE ENTRADA HTTP (crítico): "API REST/HTTP" servida por Lambdas EXIGE um Fn.ApiGateway com routes[] apontando para cada lambdaId. Se NENHUM arquivo tiver Fn.ApiGateway, CRIE stacks/network/api-gateway-stack.ts com Fn.ApiGateway (type: 'HTTP', cors: true, uma rota por método). NUNCA use Network.LoadBalancer.\n` +
      `3. CRUD COMPLETO: listar/obter/criar/atualizar/deletar existem e wireadas nas rotas.\n` +
      `4. SCHEMA E SQL: tabela com TODOS os campos da spec; handler de listagem cria a tabela (CREATE TABLE IF NOT EXISTS) com todos os campos; INSERT/UPDATE leem/escrevem todos; contagem de colunas BATE com a de valores; SQL parametrizado.\n` +
      `5. REFERÊNCIAS: env vars de banco usam o id real do Database (ex: AppDB.Endpoint); rotas usam lambdaId reais.\n` +
      `6. IAM: toda Lambda que acessa serviço AWS (DynamoDB, S3, SQS, SNS, Secrets Manager) TEM Policy.IAM anexada com as actions mínimas? Sem isso dá AccessDenied. Se faltar, ADICIONE.\n\n` +
      `Se houver QUALQUER defeito, retorne o JSON COMPLETO CORRIGIDO com os ${parsed.files.length} arquivo(s). Se estiver perfeito, retorne o mesmo JSON. Responda APENAS com o JSON.`;
    session.addUserMessage(reviewPrompt);
    const reviewChunks = [];
    const reviewProvider = (aiProvider && responseLang)
      ? createReviewProvider(aiProvider, projectContext, responseLang)
      : provider;
    try {
      await reviewProvider.stream(session.getMessages(), chunk => reviewChunks.push(chunk));
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

  // Rastreia o que a IA escreveu em disco para reconciliar órfãos entre as
  // tentativas de auto-correção do loop de synth (ver removeOrphanedGeneratedFiles).
  let previouslyWritten = [];
  if (parsed.files.length > 0) {
    // Descarta linhas residuais do paste que ficaram na fila —
    // sem isso, o confirm "Aplicar mudanças? [y/n]" consome essas
    // sobras em vez de esperar o y/n real do usuário.
    while (_lineQueue.length > 0) _lineQueue.shift();
    previouslyWritten = await writeGeneratedFiles(parsed.files, cwd, dryRun, ask, currentLang);
    invalidateIndexCache(cwd);
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
    const silentAsk = async () => 'y';
    const initialSigs = extractConstructSignatures(parsed.files);
    for (let attempt = 1; attempt <= MAX_SYNTH_RETRIES; attempt++) {
      process.stderr.write(chalk.dim(`  → Validando synth (${attempt}/${MAX_SYNTH_RETRIES})...\n`));
      const { success, output } = runSynthCapture(cwd, iacProvider);
      if (success) {
        const currentSigs = extractConstructSignatures(parsed.files);
        const removed = [...initialSigs].filter(s => !currentSigs.has(s));
        if (removed.length > 0 && attempt < MAX_SYNTH_RETRIES) {
          process.stderr.write(chalk.yellow(`  ✗ Synth passou mas a correção removeu constructs — restaurando...\n`));
          session.addUserMessage(buildIntegrityWarning(removed, parsed.files.length));
          const retryChunks = [];
          try {
            await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
            const retryRaw = retryChunks.join('');
            session.addAssistantMessage(retryRaw);
            try {
              const retryParsed = extractResponse(retryRaw);
              parsed = retryParsed;
              parsed.files = parsed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop()));
              const written2 = await writeGeneratedFiles(parsed.files, cwd, false, silentAsk, currentLang);
              if (written2.length > 0) {
                const orphans = removeOrphanedGeneratedFiles(previouslyWritten, parsed.files, cwd);
                if (orphans.length > 0) process.stderr.write(chalk.dim(`  ✗ removidos ${orphans.length} órfão(s): ${orphans.join(', ')}\n`));
                previouslyWritten = written2;
              }
              invalidateIndexCache(cwd);
            } catch { /* mantém parsed anterior */ }
          } catch (err) {
            process.stderr.write(chalk.red(`  ✗ Erro no retry: ${err.message}\n`));
          }
          continue;
        }
        process.stderr.write(chalk.green('  ✓ Synth validado\n'));
        synthOk = true;
        break;
      }
      process.stderr.write(chalk.yellow(`  ✗ Synth falhou — corrigindo automaticamente...\n`));
      if (attempt === MAX_SYNTH_RETRIES) break;
      const originalFileCount = parsed.files.length;
      // Erro "handler sem arquivo de origem": o modelo tende a "corrigir" mudando o
      // campo handler na stack em vez de criar o src/ faltante — e nunca converge.
      // Detecta o erro, extrai os src/ esperados e pede EXPLICITAMENTE para criá-los.
      const missingSrc = [
        ...new Set([...output.matchAll(/esperado (src\/[\w./-]+\.ts)/g)].map(m => m[1])),
      ];
      if (missingSrc.length > 0) {
        session.addUserMessage(
          `O comando "iacmp synth" falhou porque handlers de Lambda NÃO têm arquivo de origem:\n\n${output}\n\n` +
          `AÇÃO OBRIGATÓRIA: os arquivos de handler abaixo estão FALTANDO — CRIE cada um com a função exportada:\n` +
          missingSrc.map(p => `  • ${p}`).join('\n') + `\n\n` +
          `NÃO altere o campo "handler" nas stacks para contornar o erro — o path está correto; o que falta é o arquivo src/. ` +
          `Retorne o JSON completo com TODAS as ${originalFileCount} stack(s)/arquivo(s) anteriores MAIS os novos arquivos src/ criados acima.`
        );
      } else {
        session.addUserMessage(
          `O comando "iacmp synth" falhou com o seguinte erro:\n\n${output}\n\n` +
          `Corrija os arquivos e retorne o JSON completo com TODOS os ${originalFileCount} arquivo(s) da resposta anterior. ` +
          `Se o erro indicar arquivos faltando (ex: handlers src/), ADICIONE esses arquivos novos — não se limite ao conjunto anterior.`
        );
      }
      const retryChunks = [];
      try {
        await provider.stream(session.getMessages(), chunk => retryChunks.push(chunk));
        const retryRaw = retryChunks.join('');
        session.addAssistantMessage(retryRaw);
        try {
          const retryParsed = extractResponse(retryRaw);
          parsed = retryParsed;
          parsed.files = parsed.files.filter(f => !PROTECTED_FILES.has(f.path.split('/').pop()));
          // Cada regeneração SUBSTITUI o conjunto anterior. Escreve a nova geração
          // e, SÓ se ela foi de fato aplicada, remove as stacks/handlers órfãos da
          // tentativa anterior — senão o synth (que carrega TODAS as .ts de
          // stacks/) segue vendo constructs duplicados e não converge.
          const written = await writeGeneratedFiles(parsed.files, cwd, false, silentAsk, currentLang);
          if (written.length > 0) {
            const orphans = removeOrphanedGeneratedFiles(previouslyWritten, parsed.files, cwd);
            if (orphans.length > 0) {
              process.stderr.write(chalk.dim(`  ✗ removidos ${orphans.length} arquivo(s) órfão(s) da tentativa anterior: ${orphans.join(', ')}\n`));
            }
            previouslyWritten = written;
          }
          invalidateIndexCache(cwd);
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
  const hasConfig = fs.existsSync(iacmpConfig);
  const hasCore = fs.existsSync(path.join(cwd, 'node_modules', '@iacmp', 'core'));

  if (hasConfig && hasCore) return;

  const projectName = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const created = [];

  if (!hasConfig) {
    fs.writeFileSync(iacmpConfig, JSON.stringify({
      name: projectName,
      provider: iacProvider,
      region: 'us-east-1',
      resourceGroup: `${projectName}-rg`,
      azureRegion: 'eastus2',
    }, null, 2) + '\n', 'utf-8');
    created.push('iacmp.json');
  }

  const tsconfigPath = path.join(cwd, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(tsconfigPath, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'bundler',
        lib: ['es2022'],
        types: ['node'],
        strict: false,
        skipLibCheck: true,
        outDir: 'dist',
        rootDir: 'src',
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    }, null, 2) + '\n', 'utf-8');
    created.push('tsconfig.json');
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: projectName,
      version: '1.0.0',
      private: true,
      scripts: { build: 'tsc', synth: 'iacmp synth', deploy: 'iacmp deploy' },
      dependencies: {},
      devDependencies: { typescript: '*', tsx: '*', '@iacmp/core': '*' },
    }, null, 2) + '\n', 'utf-8');
    created.push('package.json');
  }

  if (!hasCore) {
    process.stdout.write(chalk.dim('  Instalando dependências (tsx, @iacmp/core)...\n'));
    try {
      // Resolve @iacmp/core local do monorepo se disponível
      let coreSpec = '@iacmp/core';
      try {
        const corePkg = require.resolve('@iacmp/core/package.json');
        const coreDir = path.dirname(corePkg);
        coreSpec = coreDir;
      } catch {}
      cp.execSync(`npm install ${coreSpec} tsx typescript @types/node`, { cwd, stdio: 'pipe' });
      created.push('deps: tsx, typescript, @iacmp/core');
    } catch (err) {
      process.stdout.write(chalk.yellow(`  Aviso: npm install falhou — ${err.message}\n`));
    }
  }

  if (created.length > 0) {
    console.log(chalk.dim(`  Projeto inicializado: ${created.join(', ')}\n`));
  }
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

  let lastContextHash = '';
  let _pendingRetry = false;
  let _pendingEnrichedInput = null;
  let _pendingContext = null;

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

    const hasStacks = freshContext.includes('Stacks existentes');

    function extractStacksSection(ctx) {
      const start = ctx.indexOf('## Stacks existentes');
      if (start === -1) return '';
      return ctx.slice(start);
    }

    // As stacks já vão para o system prompt via buildSystemPrompt(freshContext).
    // Só reinjeta na mensagem do usuário quando o contexto mudou (ou na primeira
    // mensagem) — evita dobrar os tokens de input a cada turn.
    const contextHash = require('crypto').createHash('md5').update(freshContext).digest('hex').slice(0, 8);
    const contextChanged = contextHash !== lastContextHash;
    lastContextHash = contextHash;

    const isFirstMessage = session.getMessages().length === 0;
    const stacksSection = hasStacks ? extractStacksSection(freshContext) : '';

    // Retry de erro retriável (429/503): sessão já tem a mensagem original do usuário.
    // Não adiciona nova mensagem — só re-executa a geração com o contexto anterior.
    if (_pendingRetry) {
      _pendingRetry = false;
      process.stderr.write(chalk.dim('  → retentando com o pedido anterior...\n'));
      const responseLang2 = voiceLanguageForThisTurn || currentLang;
      const provider2 = createContextualProvider(aiProvider, _pendingContext, responseLang2);
      const responded2 = await runGeneration(provider2, session, _pendingEnrichedInput, _pendingContext, aiProvider, responseLang2);
      if (responded2 === 'retry') {
        _pendingRetry = true;
      } else if (responded2) {
        saveSession(cwd, session.getMessages());
      } else {
        session.removeLast();
      }
      console.log('');
      continue;
    }

    // Enriquecimento de prompt: analisa lacunas que mudariam a arquitetura e faz
    // até 2 perguntas antes de gerar. IAM/runtime/TLS = injetados silenciosamente.
    const enrichedInput = process.stdin.isTTY
      ? await enrichPrompt(aiProvider, input, iacProvider, ask)
      : input;

    const userMessageContent = (stacksSection && (isFirstMessage || contextChanged))
      ? `${enrichedInput}\n\n[Estado atual do projeto]\n${stacksSection}`
      : enrichedInput;

    session.addUserMessage(userMessageContent);

    const responseLang = voiceLanguageForThisTurn || currentLang;
    const provider = createContextualProvider(aiProvider, freshContext, responseLang);

    const responded = await runGeneration(provider, session, enrichedInput, freshContext, aiProvider, responseLang);
    if (responded === 'retry') {
      _pendingRetry = true;
      _pendingEnrichedInput = enrichedInput;
      _pendingContext = freshContext;
    } else if (responded) {
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
