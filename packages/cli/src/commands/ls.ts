import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { errMessage, loadIacmpConfig, resolveProvider } from '../utils';
import { commandExists } from './doctor';
import { getExecutor } from '../deploy';


export default class Ls extends Command {
  static description = 'Lista as stacks disponíveis no projeto';

  static flags = {
    status: Flags.boolean({ description: 'Consulta o provider configurado e mostra quais stacks já estão deployadas de verdade (exige credenciais/CLI nativa configuradas)', default: false }),
  };

  static examples = ['$ iacmp ls', '$ iacmp ls --status'];

  async run(): Promise<void> {
    const { flags } = await this.parse(Ls);
    const cwd = process.cwd();
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.log('Diretório stacks/ não encontrado. Rode: iacmp init');
      return;
    }

    // Descoberta idêntica ao synth/deploy (ver src/commands/synth.ts): recursa
    // em subpastas de stacks/ e reconhece tanto .ts quanto .js.
    const findStackFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findStackFiles(full));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          files.push(full);
        }
      }
      return files;
    };

    const files = findStackFiles(stacksDir);

    if (files.length === 0) {
      this.log('Nenhuma stack encontrada em stacks/');
      return;
    }

    // --status consulta o provider de verdade — monta o necessário uma vez
    // antes do loop (config, executor, binário disponível) em vez de repetir
    // por stack, e degrada com um aviso único quando algo falta, sem
    // interromper a listagem local.
    let statusCtx: { region: string; resourceGroup?: string; projectId?: string } | undefined;
    let executor: ReturnType<typeof getExecutor> | undefined;
    if (flags.status) {
      const config = loadIacmpConfig(cwd);
      if (!config) {
        this.log(chalk.yellow('--status exige um projeto inicializado (iacmp.json não encontrado) — mostrando só as stacks locais.\n'));
      } else {
        try {
          const provider = resolveProvider(config);
          executor = getExecutor(provider);
          if (!executor.describeStatus) {
            this.log(chalk.yellow(`--status ainda não é suportado para o provider "${provider}" — mostrando só as stacks locais.\n`));
            executor = undefined;
          } else if (!commandExists(executor.requiredBinary)) {
            this.log(chalk.yellow(`--status exige "${executor.requiredBinary}" no PATH — mostrando só as stacks locais.\n`));
            executor = undefined;
          } else {
            statusCtx = { region: config.region ?? 'us-east-1', resourceGroup: config.resourceGroup, projectId: config.projectId };
          }
        } catch (err) {
          this.log(chalk.yellow(`${errMessage(err)} — mostrando só as stacks locais.\n`));
        }
      }
    }

    this.log('Stacks disponíveis:\n');
    for (const filePath of files) {
      const stat = fs.statSync(filePath);
      const modified = stat.mtime.toLocaleString('pt-BR');
      // nome relativo a stacks/ sem extensão (ex.: network/vpc), evitando
      // ambiguidade entre stacks de mesmo basename em subpastas distintas.
      const name = path.relative(stacksDir, filePath).replace(/\.(ts|js)$/, '');
      let line = `  ${name.padEnd(30)} modificado: ${modified}`;

      if (executor?.describeStatus && statusCtx) {
        // O nome usado na nuvem é o basename do arquivo (ver src/commands/synth.ts),
        // não o caminho relativo a stacks/ usado só para exibição aqui.
        const stackName = path.basename(filePath).replace(/\.(ts|js)$/, '');
        const result = executor.describeStatus(stackName, statusCtx);
        line += result.deployed
          ? chalk.green(`  [deployado: ${result.status ?? 'OK'}]`)
          : chalk.dim('  [não deployado]');
      }

      this.log(line);
    }
  }
}
