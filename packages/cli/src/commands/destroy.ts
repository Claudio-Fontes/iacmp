import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';
import { listTemplates, countResources, orderByDependency, providerOutDir, awsTemplateRegionMarker, AZURE_MAIN_FILE, AZURE_MAIN_STACK } from '../synth-out';
import { errMessage, loadIacmpConfig, resolveProvider, IacmpConfig } from '../utils';
import { commandExists } from './doctor';
import { getExecutor, printPlan, runCommands, listApimServices, purgeApimSoftDeleted, DestroyContext } from '../deploy';

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
    const dryRun = flags['dry-run'];

    let config: IacmpConfig | null;
    try {
      config = loadIacmpConfig(cwd);
    } catch (err) {
      this.error(errMessage(err));
    }
    if (!config) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }
    const provider = resolveProvider(config, flags.provider);
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
          await runCommands(commands);
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

    // APIM vai pra soft-delete (48h) no destroy: ocupa o nome (re-deploy colide)
    // e a quota. Captura os vivos ANTES do delete para purgar depois em background.
    const apimsToPurge = provider === 'azure' && !dryRun && config.resourceGroup
      ? listApimServices(config.resourceGroup)
      : [];
    const firePurge = () => {
      if (apimsToPurge.length === 0) return;
      purgeApimSoftDeleted(apimsToPurge);
      this.log(chalk.dim(
        `Purga do APIM soft-deleted disparada em background: ${apimsToPurge.map(a => a.name).join(', ')} ` +
        `(libera o nome para re-deploy — sem isso ficaria 48h na lixeira do Azure).`,
      ));
    };

    // Deployment único Azure (_main.bicep): destrói UMA deployment stack — a
    // "main", que rastreia todos os recursos dos módulos.
    if (provider === 'azure' && fs.existsSync(path.join(providerOutDir(cwd, 'azure'), AZURE_MAIN_FILE))) {
      if (flags.stack) {
        this.error(
          'Este projeto usa deployment único no Azure (_main.bicep) — --stack não se aplica: ' +
          'o destroy remove a stack "main" inteira. Rode sem --stack.',
        );
      }
      const mainStackName = physicalStackName(AZURE_MAIN_STACK);
      if (!dryRun && executor.describeStatus && !executor.describeStatus(mainStackName, baseCtx).deployed) {
        this.log(`Stack "${AZURE_MAIN_STACK}" (deployment único) não está deployada — nada a destruir.`);
        return;
      }
      this.log(`Stack: ${AZURE_MAIN_STACK} (deployment único — remove todos os módulos)`);
      const ctx: DestroyContext = { ...baseCtx, stackName: mainStackName };
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
          await runCommands(commands);
        } catch (err) {
          this.error(errMessage(err));
        }
        firePurge();
      }
      this.log(chalk.green('\nDestroy concluído.'));
      return;
    }

    for (const t of templates) {
      // Stack AWS marcada com region: 'dr' vive na drRegion do iacmp.json.
      let stackRegion = region;
      if (provider === 'aws' && awsTemplateRegionMarker(t.filePath) === 'dr') {
        if (!config.drRegion) {
          this.error(`Stack "${t.stackName}" está marcada para a região de DR, mas o iacmp.json não tem "drRegion".`);
        }
        stackRegion = config.drRegion;
      }
      const stackCtx = { ...baseCtx, region: stackRegion };

      // Em modo real (não dry-run), pular stacks que não estão deployadas para evitar erro "not found"
      if (!dryRun && executor.describeStatus) {
        const status = executor.describeStatus(physicalStackName(t.stackName), stackCtx);
        if (!status.deployed) {
          this.log(`Stack: ${t.stackName} ${chalk.yellow('(não deployada — ignorada)')}`);
          this.log('');
          continue;
        }
      }

      this.log(`Stack: ${t.stackName}${stackRegion !== region ? ` [DR: ${stackRegion}]` : ''}`);
      const ctx: DestroyContext = { ...stackCtx, stackName: physicalStackName(t.stackName) };

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
          await runCommands(commands);
        } catch (err) {
          this.error(errMessage(err));
        }
      }
      this.log('');
    }

    if (!dryRun) firePurge();
    this.log(chalk.green('Destroy concluído.'));
  }
}
