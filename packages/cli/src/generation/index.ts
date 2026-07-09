import chalk from 'chalk';
import ora from 'ora';
import {
  AIProvider,
  ChatSession,
  extractResponse,
  runSynthCapture,
  printExplanation,
  printWarnings,
  printNextSteps,
  AIGeneratedResponse,
  getCached,
  setCache,
} from '@iacmp/ai';
import { streamInitial, streamRaw } from './chat-loop';
import { stripProtectedFiles, mergeReviewedFiles } from './response-parser';
import {
  collectExistingGeneratedFiles,
  persistInitial,
  rewriteAndReconcile,
  applyConfig,
  AskFn,
} from './file-persister';
import { validateWithAutoInstall } from './synth-validator';
import {
  REVIEW_PROMPT,
  buildAzureSdkCorrection,
  buildTsErrorCorrection,
  buildHandlerTsCorrection,
  classifySynthError,
} from './autocorrect';

export type { AskFn };

const MAX_SYNTH_RETRIES = 5;

// Obtém a resposta bruta da IA: reaproveita o cache (só se for JSON válido) ou
// faz o streaming da geração inicial. Retorna { raw, fromCache } ou null se a IA
// falhar. `raw === ''` sinaliza cache envenenado já descartado (segue pro stream).
async function obtainRawResponse(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  lastUserPrompt: string
): Promise<{ raw: string; fromCache: boolean } | null> {
  const cached = getCached(cwd, lastUserPrompt);
  if (cached) {
    try {
      extractResponse(cached);
      console.log(chalk.dim('  ↩ resposta do cache'));
      session.addAssistantMessage(cached);
      return { raw: cached, fromCache: true };
    } catch {
      // Cache envenenado — descarta e cai no streaming abaixo.
    }
  }

  const streamed = await streamInitial(provider, session);
  if (streamed === null) return null;
  session.addAssistantMessage(streamed);
  return { raw: streamed, fromCache: false };
}

// Auto-revisão semântica: a IA critica a própria resposta contra o pedido,
// pegando erros de intenção que TS/synth não pegam (construct errado, CRUD
// incompleto, schema/SQL faltando). Devolve o JSON revisado (merge por path) ou
// o original se a revisão nada retornar. Muta a sessão com o turno de revisão.
async function applySemanticReview(
  provider: AIProvider,
  session: ChatSession,
  parsed: AIGeneratedResponse
): Promise<AIGeneratedResponse> {
  const spinner = ora({ text: 'Auto-revisão da geração...', spinner: 'dots', discardStdin: false }).start();
  session.addUserMessage(REVIEW_PROMPT(parsed.files.length));
  try {
    const reviewRaw = await streamRaw(provider, session);
    session.addAssistantMessage(reviewRaw);
    try {
      const reviewed = extractResponse(reviewRaw);
      if (reviewed.files.length > 0) {
        stripProtectedFiles(reviewed);
        const merged = mergeReviewedFiles(parsed.files, reviewed.files);
        const changed = JSON.stringify(merged) !== JSON.stringify(parsed.files);
        reviewed.files = merged;
        spinner.succeed(changed ? 'Auto-revisão aplicou correções' : 'Auto-revisão: nada a corrigir');
        return reviewed;
      }
      spinner.stop();
    } catch {
      spinner.stop(); // revisão não retornou JSON — mantém o original
    }
  } catch (err) {
    spinner.warn('Auto-revisão falhou (seguindo com a geração original): ' + (err as Error).message);
  }
  return parsed;
}

// Valida o TypeScript da geração inicial e, se falhar, pede uma rodada de
// correção à IA (com hint ciente do datastore/SDK). Devolve o JSON corrigido ou
// o original se a correção não vier ou não parsear.
async function fixInitialTypeErrors(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  iacProvider: string,
  parsed: AIGeneratedResponse
): Promise<AIGeneratedResponse> {
  const tsFiles = parsed.files.filter(f => f.path.endsWith('.ts'));
  if (tsFiles.length === 0) return parsed;

  const result = validateWithAutoInstall(tsFiles, cwd, iacProvider, parsed.files);
  if (result.valid) return parsed;

  const spinner = ora({ text: 'Validação TypeScript falhou — corrigindo...', spinner: 'dots', discardStdin: false }).start();
  const originalFileCount = parsed.files.length;
  session.addUserMessage(buildTsErrorCorrection(result.errors, iacProvider, parsed.files, originalFileCount));
  try {
    const retryRaw = await streamRaw(provider, session);
    spinner.succeed('Código corrigido');
    session.addAssistantMessage(retryRaw);
    try {
      const retryParsed = extractResponse(retryRaw);
      if (retryParsed.files.length < originalFileCount) {
        console.log(chalk.yellow(
          `  ⚠ a correção devolveu menos arquivos que a resposta original (${retryParsed.files.length} vs ${originalFileCount}) — confira se nada foi perdido.`
        ));
      }
      return retryParsed;
    } catch { /* usa original */ }
  } catch (err) {
    spinner.fail('Erro no retry: ' + (err as Error).message);
  }
  return parsed;
}

// Loop de auto-correção via `iacmp synth`: valida, classifica o erro, pede a
// correção à IA, reescreve os arquivos e reconcilia órfãos — até passar ou
// esgotar as tentativas. Reescreve `parsed` a cada rodada aplicada.
async function runSynthCorrectionLoop(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  iacProvider: string,
  initial: AIGeneratedResponse,
  previouslyWritten: string[]
): Promise<AIGeneratedResponse> {
  let parsed = initial;
  let written = previouslyWritten;
  let synthOk = false;

  for (let attempt = 1; attempt <= MAX_SYNTH_RETRIES; attempt++) {
    const spinner = ora({ text: `Validando com iacmp synth (tentativa ${attempt}/${MAX_SYNTH_RETRIES})...`, spinner: 'dots', discardStdin: false }).start();
    const { success, output } = runSynthCapture(cwd, iacProvider);
    let correctionMsg: string | null = null;

    if (!success) {
      spinner.fail('Synth falhou — corrigindo automaticamente...');
      correctionMsg = classifySynthError(output, parsed.files, attempt, MAX_SYNTH_RETRIES);
    } else {
      // Synth passou, mas o loop pode ter reescrito handlers (src/*.ts) sem
      // revalidar TypeScript. Revalida. O SDK errado no Azure tem PRIORIDADE
      // sobre o TS: costuma SER a causa do erro TS (ex: data-tables.getSignedUrl
      // inexistente num cenário de blob), por isso roda mesmo com TS inválido.
      const currentTs = parsed.files.filter(f => f.path.endsWith('.ts'));
      const tsResult: { valid: boolean; errors: string[] } = currentTs.length > 0
        ? validateWithAutoInstall(currentTs, cwd, iacProvider, parsed.files)
        : { valid: true, errors: [] };
      const azureSdkMsg = iacProvider === 'azure' ? buildAzureSdkCorrection(parsed.files) : null;
      if (azureSdkMsg) {
        spinner.fail('Azure: handlers com SDK errado — corrigindo...');
        correctionMsg = azureSdkMsg;
      } else if (tsResult.valid) {
        spinner.succeed('Synth validado');
        applyConfig(parsed, cwd);
        synthOk = true;
        break;
      } else {
        spinner.fail('Handler com erro de TypeScript — corrigindo automaticamente...');
        correctionMsg = buildHandlerTsCorrection(tsResult.errors, parsed.files.length);
      }
    }

    if (attempt === MAX_SYNTH_RETRIES || !correctionMsg) break;
    session.addUserMessage(correctionMsg);
    const retrySpinner = ora({ text: 'Aguardando correção da IA...', spinner: 'dots', discardStdin: false }).start();
    try {
      const retryRaw = await streamRaw(provider, session);
      retrySpinner.succeed('Arquivos corrigidos pela IA');
      session.addAssistantMessage(retryRaw);
      try {
        parsed = extractResponse(retryRaw);
        stripProtectedFiles(parsed);
        // Cada regeneração SUBSTITUI o conjunto anterior: escreve a nova geração e
        // remove os órfãos da tentativa anterior.
        written = await rewriteAndReconcile(parsed, cwd, written);
      } catch { /* mantém parsed anterior */ }
    } catch (err) {
      retrySpinner.fail('Erro no retry: ' + (err as Error).message);
      break;
    }
  }

  if (!synthOk) {
    console.log(chalk.yellow('\n  ⚠ Não foi possível corrigir automaticamente — revise os arquivos gerados.'));
  }

  return parsed;
}

// Orquestra a geração completa: obtém a resposta (cache/stream), auto-revisa,
// valida TypeScript, persiste os arquivos e roda o loop de auto-correção do
// synth. Retorna o JSON final, ou null quando a IA falha ou responde em texto.
export async function runGeneration(
  provider: AIProvider,
  session: ChatSession,
  cwd: string,
  dryRun: boolean,
  iacProvider: string,
  ask: AskFn,
  lastUserPrompt: string
): Promise<AIGeneratedResponse | null> {
  // Captura os artefatos de sessões ANTERIORES antes de chamar a IA — a primeira
  // escrita usa isso para remover stacks órfãs que não fazem parte desta geração.
  const preExistingGeneratedFiles = collectExistingGeneratedFiles(cwd);

  const obtained = await obtainRawResponse(provider, session, cwd, lastUserPrompt);
  if (obtained === null) return null;
  const { raw, fromCache } = obtained;

  let parsed: AIGeneratedResponse;
  try {
    parsed = extractResponse(raw);
  } catch {
    // Resposta conversacional — exibe como texto sem gravar no cache.
    console.log('\n' + raw.trim() + '\n');
    return null;
  }

  // Só grava no cache após parse bem-sucedido.
  if (!fromCache) {
    setCache(cwd, lastUserPrompt, raw);
  }

  // Arquivos de projeto/ambiente são do bootstrap, NÃO da IA. Descarta antes de escrever.
  stripProtectedFiles(parsed);

  // Auto-revisão semântica — pula no cache (já revisado) e sem arquivos (conversacional).
  if (!fromCache && parsed.files.length > 0) {
    parsed = await applySemanticReview(provider, session, parsed);
  }

  parsed = await fixInitialTypeErrors(provider, session, cwd, iacProvider, parsed);

  printExplanation(parsed.explanation);
  printWarnings(parsed.warnings);

  let previouslyWritten: string[] = [];
  if (parsed.files.length > 0) {
    previouslyWritten = await persistInitial(parsed, cwd, dryRun, ask, preExistingGeneratedFiles);
  }

  printNextSteps(parsed.nextSteps);

  if (!dryRun && parsed.files.length > 0) {
    parsed = await runSynthCorrectionLoop(provider, session, cwd, iacProvider, parsed, previouslyWritten);
  }

  return parsed;
}
