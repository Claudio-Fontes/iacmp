import { Command, Help } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function firstExampleText(examples?: Command.Example[]): string | undefined {
  const first = examples?.[0];
  if (!first) return undefined;
  return typeof first === 'string' ? first : first.command;
}

/**
 * A listagem raiz (`iacmp` sem comando) só mostra descrição de uma linha por
 * padrão no oclif — exemplos só aparecem em `iacmp <comando> --help`. Esta
 * classe injeta o primeiro exemplo de cada comando direto na listagem raiz,
 * para reduzir o ping-pong de digitar `--help` em cada comando só pra
 * descobrir como usá-lo.
 */
export default class IacmpHelp extends Help {
  // `iacmp` sem comando, fora de um projeto: quem acabou de instalar cai aqui.
  // Um bloco de primeiros passos antes da lista de 20+ comandos responde "e
  // agora?" sem obrigar ninguém a abrir o README.
  async showRootHelp(): Promise<void> {
    const inProject = fs.existsSync(path.join(process.cwd(), 'iacmp.json'));
    if (!inProject) {
      console.log(chalk.bold('\nPrimeiros passos'));
      console.log('  iacmp init meu-projeto      ' + chalk.dim('# cria um projeto de exemplo pronto para deploy'));
      console.log('  cd meu-projeto');
      console.log('  iacmp synth                 ' + chalk.dim('# CloudFormation, Bicep ou Terraform + validações'));
      console.log('  iacmp deploy --dry-run      ' + chalk.dim('# o plano, sem executar nada'));
      console.log('');
      console.log('  ' + chalk.dim('Claude Code: iacmp setup · Docs: https://github.com/Claudio-Fontes/iacmp'));
    }
    await super.showRootHelp();
  }

  protected formatCommands(commands: Command.Loadable[]): string {
    if (commands.length === 0) return '';

    const rows = commands
      .filter(c => c.id)
      .map(c => {
        const summary = this.summary(c);
        const example = firstExampleText(c.examples);
        const right = [summary, example ? chalk.dim(example) : undefined]
          .filter(Boolean)
          .join('\n');
        return [chalk.bold(c.id), right];
      });

    const body = this.renderList(rows, {
      indentation: 2,
      multiline: true,
      stripAnsi: this.opts.stripAnsi,
    });
    return this.section('COMMANDS', body);
  }
}
