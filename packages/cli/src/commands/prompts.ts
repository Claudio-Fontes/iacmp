import { Command, Flags, Args } from '@oclif/core';
import chalk from 'chalk';
import { t } from '../i18n';
import { PROMPT_LIBRARY, CATEGORIES } from '../prompt-library';

export default class Prompts extends Command {
  static description = t('Biblioteca de prompts prontos para usar com iacmp ai', 'Library of ready-to-use prompts for iacmp ai');

  static examples = [
    '$ iacmp prompts',
    '$ iacmp prompts --category Backend',
    '$ iacmp prompts 02',
    '$ iacmp prompts 02 --copy',
  ];

  static args = {
    id: Args.string({ description: t('ID ou número do prompt (ex: 02 ou 02-serverless-api-dynamodb)', 'Prompt ID or number (e.g. 02 or 02-serverless-api-dynamodb)'), required: false }),
  };

  static flags = {
    category: Flags.string({ char: 'c', description: t(`Filtra por categoria: ${CATEGORIES.join(', ')}`, `Filters by category: ${CATEGORIES.join(', ')}`) }),
    copy: Flags.boolean({ description: t('Copia o prompt para o clipboard (requer pbcopy/xclip)', 'Copies the prompt to the clipboard (requires pbcopy/xclip)'), default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Prompts);

    if (args.id) {
      const needle = args.id!;
      const found = PROMPT_LIBRARY.find(
        p => p.id === needle || p.id.startsWith(needle + '-') || p.id.split('-')[0] === needle.padStart(2, '0'),
      );
      if (!found) {
        this.error(t(`Prompt "${needle}" não encontrado. Use "iacmp prompts" para listar todos.`, `Prompt "${needle}" not found. Use "iacmp prompts" to list them all.`));
      }

      this.log('');
      this.log(chalk.bold.cyan(`[${found.id}] ${found.title}`));
      this.log(chalk.dim(t(`Categoria: ${found.category}`, `Category: ${found.category}`)));
      this.log(chalk.dim(found.description));
      this.log('');
      this.log(chalk.bold('Prompt:'));
      this.log(chalk.white(found.prompt));
      this.log('');
      this.log(chalk.dim(t(`Para usar: iacmp ai "${found.prompt.split('\n')[0].substring(0, 60)}..."`, `To use: iacmp ai "${found.prompt.split('\n')[0].substring(0, 60)}..."`)));

      if (flags.copy) {
        try {
          const { execSync } = await import('child_process');
          const cmd = process.platform === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
          execSync(cmd, { input: found.prompt });
          this.log(chalk.green(t('Prompt copiado para o clipboard.', 'Prompt copied to the clipboard.')));
        } catch {
          this.log(chalk.yellow(t('Não foi possível copiar automaticamente. Copie o texto acima manualmente.', 'Could not copy automatically. Copy the text above manually.')));
        }
      }
      return;
    }

    const list = flags.category
      ? PROMPT_LIBRARY.filter(p => p.category.toLowerCase() === flags.category!.toLowerCase())
      : PROMPT_LIBRARY;

    if (list.length === 0) {
      this.error(t(`Nenhum prompt encontrado para a categoria "${flags.category}". Categorias disponíveis: ${CATEGORIES.join(', ')}`, `No prompt found for category "${flags.category}". Available categories: ${CATEGORIES.join(', ')}`));
    }

    this.log('');
    this.log(chalk.bold(t('Biblioteca de Prompts iacmp', 'iacmp Prompt Library')));
    this.log(chalk.dim(t('Use: iacmp prompts <id> para ver o prompt completo\n', 'Use: iacmp prompts <id> to see the full prompt\n')));

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

    this.log(chalk.dim(t(`Total: ${list.length} prompts em ${Object.keys(grouped).length} categorias`, `Total: ${list.length} prompts in ${Object.keys(grouped).length} categories`)));
    this.log(chalk.dim(t('Use "iacmp prompts <número>" para ver o prompt completo e copiá-lo.', 'Use "iacmp prompts <number>" to see the full prompt and copy it.')));
    this.log('');
  }
}
