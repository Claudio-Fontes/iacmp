import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { NativeCommand } from './types';

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
 * Executa cada comando na ordem, com stdio herdado — o usuário vê em tempo
 * real a saída (e qualquer erro de autenticação) do aws/az/gcloud/terraform.
 * stdio:'inherit' significa que não há stderr capturado para inspecionar
 * aqui; a mensagem de erro aponta para a saída já impressa + `iacmp doctor`.
 */
export function runCommands(commands: NativeCommand[]): void {
  for (const cmd of commands) {
    cmd.preRun?.();
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
