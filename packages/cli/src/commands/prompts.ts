import { Command, Flags, Args } from '@oclif/core';
import chalk from 'chalk';
import { PROMPT_LIBRARY, CATEGORIES } from '../prompt-library';

export default class Prompts extends Command {
  static description = 'Biblioteca de prompts prontos para usar com iacmp ai';

  static examples = [
    '$ iacmp prompts',
    '$ iacmp prompts --category Backend',
    '$ iacmp prompts 02',
    '$ iacmp prompts 02 --copy',
  ];

  static args = {
    id: Args.string({ description: 'ID ou número do prompt (ex: 02 ou 02-serverless-api-dynamodb)', required: false }),
  };

  static flags = {
    category: Flags.string({ char: 'c', description: `Filtra por categoria: ${CATEGORIES.join(', ')}` }),
    copy: Flags.boolean({ description: 'Copia o prompt para o clipboard (requer pbcopy/xclip)', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Prompts);

    if (args.id) {
      const needle = args.id!;
      const found = PROMPT_LIBRARY.find(
        p => p.id === needle || p.id.startsWith(needle + '-') || p.id.split('-')[0] === needle.padStart(2, '0'),
      );
      if (!found) {
        this.error(`Prompt "${needle}" não encontrado. Use "iacmp prompts" para listar todos.`);
      }

      this.log('');
      this.log(chalk.bold.cyan(`[${found.id}] ${found.title}`));
      this.log(chalk.dim(`Categoria: ${found.category}`));
      this.log(chalk.dim(found.description));
      this.log('');
      this.log(chalk.bold('Prompt:'));
      this.log(chalk.white(found.prompt));
      this.log('');
      this.log(chalk.dim(`Para usar: iacmp ai "${found.prompt.split('\n')[0].substring(0, 60)}..."`));

      if (flags.copy) {
        try {
          const { execSync } = await import('child_process');
          const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
          execSync(cmd, { input: found.prompt });
          this.log(chalk.green('Prompt copiado para o clipboard.'));
        } catch {
          this.log(chalk.yellow('Não foi possível copiar automaticamente. Copie o texto acima manualmente.'));
        }
      }
      return;
    }

    const list = flags.category
      ? PROMPT_LIBRARY.filter(p => p.category.toLowerCase() === flags.category!.toLowerCase())
      : PROMPT_LIBRARY;

    if (list.length === 0) {
      this.error(`Nenhum prompt encontrado para a categoria "${flags.category}". Categorias disponíveis: ${CATEGORIES.join(', ')}`);
    }

    this.log('');
    this.log(chalk.bold('Biblioteca de Prompts iacmp'));
    this.log(chalk.dim('Use: iacmp prompts <id> para ver o prompt completo\n'));

    const grouped = CATEGORIES.reduce<Record<string, typeof list>>((acc, cat) => {
      const items = list.filter(p => p.category === cat);
      if (items.length > 0) acc[cat] = items;
      return acc;
    }, {});

    for (const [cat, items] of Object.entries(grouped)) {
      this.log(chalk.bold.yellow(`  ${cat}`));
      for (const p of items) {
        this.log(`    ${chalk.cyan(p.id.split('-')[0])}  ${chalk.white(p.title)}`);
        this.log(`       ${chalk.dim(p.description)}`);
      }
      this.log('');
    }

    this.log(chalk.dim(`Total: ${list.length} prompts em ${Object.keys(grouped).length} categorias`));
    this.log(chalk.dim('Use "iacmp prompts <número>" para ver o prompt completo e copiá-lo.'));
    this.log('');
  }
}
