import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';
import { listTemplates, countResources, orderByDependency } from '../synth-out';
import { readJsonFile, errMessage } from '../utils';
import { commandExists } from './doctor';
import { getExecutor, printPlan, runCommands, DestroyContext } from '../deploy';

interface IacmpConfig {
  name?: string;
  provider?: string;
  region?: string;
  azureRegion?: string;
  resourceGroup?: string;
  projectId?: string;
}

export default class Destroy extends Command {
  static description = 'Destroi a infraestrutura do provider configurado';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform) — default: o provider do iacmp.json' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
    force: Flags.boolean({ char: 'f', description: 'Pula confirmação' }),
    'dry-run': Flags.boolean({ description: 'Mostra os comandos que seriam executados, sem rodar nada', default: false }),
  };

  static examples = [
    '$ iacmp destroy',
    '$ iacmp destroy --stack minha-stack',
    '$ iacmp destroy --force',
    '$ iacmp destroy --dry-run',
  ];

  private async confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(`${message} (y/N): `, answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Destroy);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');
    const dryRun = flags['dry-run'];

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    let config: IacmpConfig;
    try {
      config = readJsonFile<IacmpConfig>(configPath);
    } catch (err) {
      this.error(errMessage(err));
    }
    const provider = flags.provider ?? config.provider ?? 'aws';
    const region = (provider === 'azure' ? config.azureRegion : undefined) ?? config.region ?? 'us-east-1';

    let executor;
    try {
      executor = getExecutor(provider);
    } catch (err) {
      this.error(errMessage(err));
    }

    if (provider === 'terraform' && flags.stack) {
      this.error('--stack não é suportado para --provider terraform nesta fase — deploy/destroy operam no diretório terraform inteiro (todas as stacks compartilham um state).');
    }

    // Confere se há algo sintetizado antes de checar CLI/credenciais — "rode
    // iacmp synth" é o fix mais provável e não deveria depender do ambiente.
    // Ordem REVERSA da de deploy: quem IMPORTA (Fn::ImportValue) precisa ser
    // destruído antes de quem EXPORTA — senão a stack exportadora não pode
    // ser removida enquanto o Export ainda está em uso por outra stack.
    const templates = orderByDependency(listTemplates(cwd, provider, flags.stack)).reverse();
    if (templates.length === 0) {
      this.error(`Nenhuma stack encontrada para destruir. Rode: iacmp synth --provider ${provider}`);
    }

    if (provider === 'azure' && !config.resourceGroup) {
      this.error('Configure "resourceGroup" no iacmp.json para usar --provider azure.');
    }

    // Nome físico da stack no CloudFormation = prefixado com o nome do projeto
    // (mesmo critério do deploy). Sem config.name, comportamento sem prefixo.
    const physicalStackName = (logicalName: string): string =>
      config.name ? `${config.name}-${logicalName}` : logicalName;

    const baseCtx: Omit<DestroyContext, 'stackName'> = {
      cwd,
      region,
      resourceGroup: config.resourceGroup,
      projectId: config.projectId,
    };

    if (provider === 'terraform') {
      for (const t of templates) {
        this.log(`Stack: ${t.stackName} — ${countResources(t.filePath, provider)} recurso(s)`);
      }
      this.log('');
      // Confirma ANTES de checar a CLI nativa — "tem certeza?" não deveria
      // depender de ambiente, e cancelar aqui evita checagens desnecessárias.
      if (!flags.force && !dryRun) {
        const confirmed = await this.confirm('Tem certeza que deseja destruir todos os recursos do Terraform?');
        if (!confirmed) {
          this.log('Operação cancelada.');
          return;
        }
      }
      if (!dryRun && !commandExists(executor.requiredBinary)) {
        this.error(`${executor.requiredBinary} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`);
      }
      const ctx: DestroyContext = { ...baseCtx, stackName: config.name ?? 'iacmp' };
      let commands;
      try {
        commands = await executor.planDestroy(ctx);
      } catch (err) {
        this.error(errMessage(err));
      }
      if (dryRun) {
        printPlan(commands);
      } else {
        try {
          runCommands(commands);
        } catch (err) {
          this.error(errMessage(err));
        }
      }
      this.log(chalk.green('\nDestroy concluído.'));
      return;
    }

    let totalResources = 0;
    const stackNames: string[] = [];
    for (const t of templates) {
      totalResources += countResources(t.filePath, provider);
      stackNames.push(t.stackName);
    }

    this.log(`Stacks a destruir: ${stackNames.join(', ')}`);
    this.log(`Total de recursos: ${totalResources} em ${provider.toUpperCase()}`);
    this.log('');

    if (!flags.force && !dryRun) {
      const confirmed = await this.confirm('Tem certeza que deseja destruir esses recursos?');
      if (!confirmed) {
        this.log('Operação cancelada.');
        return;
      }
    }

    if (!dryRun && !commandExists(executor.requiredBinary)) {
      this.error(`${executor.requiredBinary} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`);
    }

    for (const t of templates) {
      // Em modo real (não dry-run), pular stacks que não estão deployadas para evitar erro "not found"
      if (!dryRun && executor.describeStatus) {
        const status = executor.describeStatus(physicalStackName(t.stackName), baseCtx);
        if (!status.deployed) {
          this.log(`Stack: ${t.stackName} ${chalk.yellow('(não deployada — ignorada)')}`);
          this.log('');
          continue;
        }
      }

      this.log(`Stack: ${t.stackName}`);
      const ctx: DestroyContext = { ...baseCtx, stackName: physicalStackName(t.stackName) };

      let commands;
      try {
        commands = await executor.planDestroy(ctx);
      } catch (err) {
        this.error(errMessage(err));
      }

      if (dryRun) {
        printPlan(commands);
      } else {
        try {
          runCommands(commands);
        } catch (err) {
          this.error(errMessage(err));
        }
      }
      this.log('');
    }

    this.log(chalk.green('Destroy concluído.'));
  }
}
