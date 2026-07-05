import { Command, Flags } from '@oclif/core';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import chalk from 'chalk';
import { listTemplates, countResources, orderByDependency } from '../synth-out';
import { readJsonFile, errMessage } from '../utils';
import { commandExists } from './doctor';
import { getExecutor, printPlan, runCommands, formatCommand, resourceGroupExists, getAzureStackOutputs, findExistingRetainedResources, deleteResourceAndWait, DeployContext } from '../deploy';

interface IacmpConfig {
  name?: string;
  provider?: string;
  region?: string;
  azureRegion?: string;
  resourceGroup?: string;
  projectId?: string;
}

function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export default class Deploy extends Command {
  static description = 'Faz deploy das stacks no provider configurado';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform) — default: o provider do iacmp.json' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
    'dry-run': Flags.boolean({ description: 'Mostra os comandos que seriam executados, sem rodar nada', default: false }),
  };

  static examples = [
    '$ iacmp deploy',
    '$ iacmp deploy --provider aws --stack minha-stack',
    '$ iacmp deploy --provider azure',
    '$ iacmp deploy --provider gcp',
    '$ iacmp deploy --provider terraform',
    '$ iacmp deploy --dry-run',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
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
    // orderByDependency garante que uma stack que EXPORTA (ex: Function.Lambda
    // referenciada por outra stack via Fn::ImportValue) suba antes de quem
    // importa — sem isso o deploy real falharia com "export not found".
    const templates = orderByDependency(listTemplates(cwd, provider, flags.stack));
    if (templates.length === 0) {
      this.error(`Nenhum template encontrado para '${provider}'. Rode: iacmp synth --provider ${provider}`);
    }

    // --dry-run nunca chama a CLI nativa de verdade — não exige o binário
    // instalado, só mostra o plano (os helpers de leitura usados no plano
    // degradam graciosamente quando o binário está ausente).
    if (!dryRun && !commandExists(executor.requiredBinary)) {
      this.error(`${executor.requiredBinary} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`);
    }

    if (provider === 'azure') {
      if (!config.resourceGroup) {
        this.error('Configure "resourceGroup" no iacmp.json para usar --provider azure (ex: "resourceGroup": "meu-rg").');
      }
      if (!resourceGroupExists(config.resourceGroup)) {
        const createCmd = { bin: 'az', args: ['group', 'create', '--name', config.resourceGroup, '--location', region] };
        if (dryRun) {
          this.log(`Resource group "${config.resourceGroup}" ainda não existe — seria criado:`);
          this.log(chalk.dim('  $ ') + formatCommand(createCmd));
        } else if (!process.stdin.isTTY) {
          // Não-TTY (CI, pipe): cria o RG automaticamente sem perguntar
          execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
        } else {
          const proceed = await confirm(`Resource group "${config.resourceGroup}" não existe. Criar agora em ${region}?`);
          if (!proceed) {
            this.error('Deploy cancelado — resource group não existe.');
          }
          execFileSync(createCmd.bin, createCmd.args, { stdio: 'inherit' });
        }
      }
    }

    this.log(`Provider: ${provider}${dryRun ? ' (dry-run)' : ''}\n`);

    // Acumula outputs de stacks Azure deployadas para injetar como params na próxima
    const azureOutputAccumulator: Record<string, string> = {};

    const baseCtx: Omit<DeployContext, 'stackName' | 'templatePath'> = {
      cwd,
      region,
      resourceGroup: config.resourceGroup,
      projectId: config.projectId,
      dryRun,
    };

    if (provider === 'terraform') {
      // Terraform opera no diretório inteiro — uma única chamada, sem loop por stack.
      for (const t of templates) {
        this.log(`Stack: ${t.stackName} — ${countResources(t.filePath, provider)} recurso(s)`);
      }
      const ctx: DeployContext = { ...baseCtx, stackName: config.name ?? 'iacmp', templatePath: '' };
      let commands;
      try {
        commands = await executor.planDeploy(ctx);
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
      this.log(chalk.green('\nDeploy concluído.'));
      return;
    }

    for (const t of templates) {
      const resourceCount = countResources(t.filePath, provider);
      this.log(`Stack: ${t.stackName} — ${resourceCount} recurso(s)`);

      // Recursos com DeletionPolicy Retain/Snapshot (bancos de dados, etc.)
      // sobrevivem à destruição da stack — uma stack anterior destruída pode
      // deixar um recurso vivo, órfão, fora do controle do CloudFormation.
      // Checagem genérica via Cloud Control API (qualquer Type), não
      // amarrada a um serviço específico. Sem isso, o deploy só descobre o
      // conflito depois de tentar criar o changeset, com um erro confuso
      // (ResourceExistenceCheck).
      if (provider === 'aws' && !dryRun) {
        const conflicts = findExistingRetainedResources(t.filePath, region, t.stackName);
        if (conflicts.length > 0) {
          const list = conflicts.map((c) => `${c.typeName} "${c.identifier}"`).join(', ');
          this.log(chalk.red(
            `\n⚠ ATENÇÃO: a stack "${t.stackName}" criaria recurso(s) que JÁ EXISTEM na conta AWS: ${list} — provavelmente retidos de uma stack anterior destruída.`
          ));
          const proceed = await confirm(
            `Apagar o(s) recurso(s) existente(s) e continuar o deploy de "${t.stackName}"? Isso é IRREVERSÍVEL e PERDE os dados atuais`
          );
          if (!proceed) {
            this.log(chalk.yellow(`Pulando "${t.stackName}" — apague ou importe o(s) recurso(s) manualmente e rode o deploy de novo.\n`));
            continue;
          }
          for (const c of conflicts) {
            await deleteResourceAndWait(c.typeName, c.identifier, region);
          }
        }
      }

      const ctx: DeployContext = {
        ...baseCtx,
        stackName: t.stackName,
        templatePath: t.filePath,
        ...(provider === 'azure' && Object.keys(azureOutputAccumulator).length > 0
          ? { outputParams: { ...azureOutputAccumulator } }
          : {}),
      };

      let commands;
      try {
        commands = await executor.planDeploy(ctx);
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
        // Azure: coleta outputs desta stack para injetar como params na próxima
        if (provider === 'azure' && config.resourceGroup) {
          const stackOutputs = getAzureStackOutputs(t.stackName, config.resourceGroup);
          Object.assign(azureOutputAccumulator, stackOutputs);
        }
      }
      this.log('');
    }

    this.log(chalk.green('Deploy concluído.'));
  }
}
