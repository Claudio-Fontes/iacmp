import { Command, Args } from '@oclif/core';
import { t } from '../i18n';
import { listConstructs, searchConstructs, RegistryConstruct } from '@iacmp/registry';

function padEnd(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function printTable(constructs: RegistryConstruct[]): void {
  if (constructs.length === 0) {
    console.log(t('Nenhum construct encontrado.', 'No construct found.'));
    return;
  }

  const header = `${padEnd(t('Nome', 'Name'), 22)} ${padEnd(t('Pacote', 'Package'), 30)} ${padEnd('Providers', 14)} ${t('Descrição', 'Description')}`;
  const sep = '-'.repeat(header.length);

  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const c of constructs) {
    const providers = c.providers.join(', ');
    console.log(
      `${padEnd(c.name, 22)} ${padEnd(c.package, 30)} ${padEnd(providers, 14)} ${c.description}`,
    );
  }

  console.log(sep);
  console.log(t(`${constructs.length} construct(s) encontrado(s).`, `${constructs.length} construct(s) found.`));
}

export default class Registry extends Command {
  static description = t('Acessa o registry de constructs da comunidade', 'Accesses the community construct registry');

  static args = {
    subcommand: Args.string({ description: t('Subcomando: list | search <termo>', 'Subcommand: list | search <term>'), required: true }),
    term: Args.string({ description: t('Termo de busca (usado com search)', 'Search term (used with search)'), required: false }),
  };

  static examples = [
    '$ iacmp registry list',
    '$ iacmp registry search cognito',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(Registry);

    switch (args.subcommand) {
      case 'list': {
        this.log(t('Constructs disponíveis no registry:\n', 'Constructs available in the registry:\n'));
        printTable(listConstructs());
        break;
      }

      case 'search': {
        if (!args.term) {
          this.error(t('Informe um termo de busca. Ex: iacmp registry search cognito', 'Provide a search term. E.g.: iacmp registry search cognito'));
        }
        this.log(t(`Buscando por "${args.term}":\n`, `Searching for "${args.term}":\n`));
        printTable(searchConstructs(args.term));
        break;
      }

      default:
        this.error(t(`Subcomando desconhecido: '${args.subcommand}'. Use: list ou search <termo>`, `Unknown subcommand: '${args.subcommand}'. Use: list or search <term>`));
    }
  }
}
