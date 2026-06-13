import { Command, Args } from '@oclif/core';
import { listConstructs, searchConstructs, RegistryConstruct } from '@iacmp/registry';

function padEnd(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function printTable(constructs: RegistryConstruct[]): void {
  if (constructs.length === 0) {
    console.log('Nenhum construct encontrado.');
    return;
  }

  const header = `${padEnd('Nome', 22)} ${padEnd('Pacote', 30)} ${padEnd('Providers', 14)} Descrição`;
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
  console.log(`${constructs.length} construct(s) encontrado(s).`);
}

export default class Registry extends Command {
  static description = 'Acessa o registry de constructs da comunidade';

  static args = {
    subcommand: Args.string({ description: 'Subcomando: list | search <termo>', required: true }),
    term: Args.string({ description: 'Termo de busca (usado com search)', required: false }),
  };

  static examples = [
    '$ iacmp registry list',
    '$ iacmp registry search cognito',
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(Registry);

    switch (args.subcommand) {
      case 'list': {
        this.log('Constructs disponíveis no registry:\n');
        printTable(listConstructs());
        break;
      }

      case 'search': {
        if (!args.term) {
          this.error('Informe um termo de busca. Ex: iacmp registry search cognito');
        }
        this.log(`Buscando por "${args.term}":\n`);
        printTable(searchConstructs(args.term));
        break;
      }

      default:
        this.error(`Subcomando desconhecido: '${args.subcommand}'. Use: list ou search <termo>`);
    }
  }
}
