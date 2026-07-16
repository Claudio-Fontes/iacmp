import { execFileSync, spawn } from 'child_process';
import chalk from 'chalk';
import { DeployContext, DeployExecutor, NativeCommand } from './types';

/**
 * Formata um comando para exibição em --dry-run (e em mensagens de erro).
 * Quando o comando tem `displayArgs`, usa-os em vez de `args` — isso garante
 * que secrets nunca apareçam em logs/terminal mesmo que o deploy falhe.
 */
export function formatCommand(cmd: NativeCommand): string {
  const effectiveArgs = cmd.displayArgs ?? cmd.args;
  const quoted = effectiveArgs.map(a => (/\s/.test(a) ? `"${a}"` : a));
  return `${cmd.bin} ${quoted.join(' ')}`;
}

/** Imprime o plano de comandos sem executar nada (--dry-run). */
export function printPlan(commands: NativeCommand[]): void {
  for (const cmd of commands) {
    console.log(chalk.dim('  $ ') + formatCommand(cmd));
  }
}

/**
 * Executa um único comando com polling paralelo de status. Usa `spawn` em vez
 * de `execFileSync` para não bloquear o event loop durante o intervalo de polling.
 * O status é renderizado em-place via `\r` — sobrescrito pelo próximo write
 * do processo filho ou pelo próximo ciclo de polling.
 */
async function runWithPolling(
  cmd: NativeCommand,
  executor: Pick<DeployExecutor, 'pollStatus'>,
  stackName: string,
  ctx: DeployContext,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.bin, cmd.args, { cwd: cmd.cwd, stdio: 'inherit' });

    let pollActive = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!pollActive) return;
      executor.pollStatus!(stackName, ctx)
        .then((status) => {
          if (status && pollActive) {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            // APIM/Cosmos seguram o delete no ARM por vários minutos DEPOIS de
            // sumirem do portal (soft-delete interno) — sem a dica, parece travado.
            const hint = /deleting/i.test(status) && elapsed > 120
              ? chalk.dim(' (normal: APIM/Cosmos levam 5-10min para o ARM confirmar, mesmo com o RG já vazio)')
              : '';
            process.stdout.write(`\r${chalk.dim(`[${stackName}]`)} ${status} ${chalk.dim(`${elapsed}s`)}${hint}   `);
          }
        })
        .catch(() => { /* polling silencioso — erro não propaga */ });
    }, 5000);

    let finished = false;
    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      pollActive = false;
      clearInterval(timer);
      process.stdout.write('\r\x1b[K'); // limpa linha de status residual
      cmd.cleanup?.();
      if (err) reject(err);
      else resolve();
    };

    const handleError = (execErr: Error) => {
      if (cmd.onError) {
        try {
          cmd.onError(execErr);
          finish();
        } catch (e) {
          finish(e as Error);
        }
      } else {
        finish(new Error(
          `Falha ao executar "${formatCommand(cmd)}" — veja a saída acima. ` +
          `Se for um problema de autenticação, configure a credencial da CLI (${cmd.bin}) e tente novamente, ou rode: iacmp doctor`,
        ));
      }
    };

    child.on('error', handleError);

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
      } else if (code === null) {
        handleError(new Error(`Process terminated by signal: ${signal ?? 'unknown'}`));
      } else {
        handleError(new Error(`${cmd.bin} terminou com código ${code}`));
      }
    });
  });
}

/**
 * Executa cada comando na ordem, com stdio herdado — o usuário vê em tempo
 * real a saída (e qualquer erro de autenticação) do aws/az/gcloud/terraform.
 *
 * Quando `opts.executor` implementa `pollStatus`, lança um polling paralelo
 * a cada 5s que renderiza o status da stack em-place no terminal (linha única
 * com `\r`). Se `pollStatus` não existe, comportamento idêntico ao anterior
 * (backward-compatible: execFileSync síncrono).
 */
export async function runCommands(
  commands: NativeCommand[],
  opts?: { executor?: DeployExecutor; stackName?: string; ctx?: DeployContext },
): Promise<void> {
  for (const cmd of commands) {
    cmd.preRun?.();
    if (opts?.executor?.pollStatus && opts.ctx) {
      const stackName = opts.stackName ?? opts.ctx.stackName;
      await runWithPolling(cmd, opts.executor, stackName, opts.ctx);
    } else {
      try {
        execFileSync(cmd.bin, cmd.args, { cwd: cmd.cwd, stdio: 'inherit' });
      } catch (e) {
        if (cmd.onError) {
          // onError pode suprimir o erro (não lança) ou re-lançar com mensagem melhor.
          cmd.onError(e as Error);
        } else {
          throw new Error(
            `Falha ao executar "${formatCommand(cmd)}" — veja a saída acima. ` +
            `Se for um problema de autenticação, configure a credencial da CLI (${cmd.bin}) e tente novamente, ou rode: iacmp doctor`
          );
        }
      } finally {
        cmd.cleanup?.();
      }
    }
  }
}
