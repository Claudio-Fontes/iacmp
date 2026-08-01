import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { t } from '../i18n';
import { listTemplates, countResources, orderByDependency, providerOutDir, AZURE_MAIN_FILE } from '../synth-out';
import { errMessage, loadIacmpConfig, resolveProvider, resolveProviderRegion, IacmpConfig } from '../utils';
import { commandExists } from './doctor';
import { getExecutor, DestroyContext } from '../deploy';
import { confirm, DeployUI, DestroyFlowOptions } from '../deploy/flows/common';
import { destroyTerraformDir } from '../deploy/flows/destroy-terraform';
import { destroyAzureMain } from '../deploy/flows/destroy-azure-main';
import { destroyStackLoop } from '../deploy/flows/destroy-stacks';
import { captureApimsToPurge, fireApimPurge, maybeDeleteEmptyRg, maybePurgeRetainedBuckets } from '../deploy/flows/destroy-cleanup';

export default class Destroy extends Command {
  static description = t('Destroi a infraestrutura do provider configurado', 'Destroys the configured provider\'s infrastructure');

  static flags = {
    provider: Flags.string({ char: 'p', description: t('Provider alvo (aws, azure, gcp) — default: o provider do iacmp.json', 'Target provider (aws, azure, gcp) — default: the provider from iacmp.json') }),
    stack: Flags.string({ char: 's', description: t('Nome da stack específica', 'Name of a specific stack') }),
    format: Flags.string({ options: ['tf'], description: t('Formato: tf = destroy via Terraform em vez do deployer nativo.', 'Format: tf = destroy via Terraform instead of the native deployer.') }),
    force: Flags.boolean({ char: 'f', description: t('Pula confirmação', 'Skips confirmation') }),
    'dry-run': Flags.boolean({ description: t('Mostra os comandos que seriam executados, sem rodar nada', 'Shows the commands that would run, without executing anything'), default: false }),
  };

  static examples = [
    '$ iacmp destroy',
    '$ iacmp destroy --stack minha-stack',
    '$ iacmp destroy --force',
    '$ iacmp destroy --dry-run',
  ];

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
      this.error(t('Projeto não inicializado. Rode: iacmp init', 'Project not initialized. Run: iacmp init'));
    }
    const provider = resolveProvider(config, flags.provider);
    const effectiveProvider =
      flags.format === 'tf' && provider === 'aws' ? 'terraform' :
      flags.format === 'tf' && provider === 'azure' ? 'azure-tf' :
      provider;
    const region = resolveProviderRegion(provider, config);

    let executor;
    try {
      executor = getExecutor(effectiveProvider);
    } catch (err) {
      this.error(errMessage(err));
    }

    if ((effectiveProvider === 'terraform' || effectiveProvider === 'azure-tf') && flags.stack) {
      this.error(t('--stack não é suportado com --format tf — destroy opera no diretório terraform inteiro (todas as stacks compartilham um state).', '--stack is not supported with --format tf — destroy operates on the whole terraform directory (all stacks share one state).'));
    }

    // Confere se há algo sintetizado antes de checar CLI/credenciais — "rode
    // iacmp synth" é o fix mais provável e não deveria depender do ambiente.
    // Ordem REVERSA da de deploy: quem IMPORTA (Fn::ImportValue) precisa ser
    // destruído antes de quem EXPORTA — senão a stack exportadora não pode
    // ser removida enquanto o Export ainda está em uso por outra stack.
    const templates = orderByDependency(listTemplates(cwd, effectiveProvider, flags.stack)).reverse();
    if (templates.length === 0) {
      this.error(t(`Nenhuma stack encontrada para destruir. Rode: iacmp synth --provider ${provider}${flags.format === 'tf' ? ' --format tf' : ''}`, `No stack found to destroy. Run: iacmp synth --provider ${provider}${flags.format === 'tf' ? ' --format tf' : ''}`));
    }

    if (provider === 'azure' && !config.resourceGroup) {
      this.error(t('Configure "resourceGroup" no iacmp.json para usar --provider azure.', 'Set "resourceGroup" in iacmp.json to use --provider azure.'));
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
      tfBackend: config.tfBackend,
    };

    const ui: DeployUI = {
      log: (msg) => this.log(msg),
      warn: (msg) => { this.warn(msg); },
      error: (msg) => this.error(msg),
    };

    const flow: DestroyFlowOptions = {
      cwd,
      config,
      provider,
      region,
      dryRun,
      force: flags.force,
      stackFlag: flags.stack,
      executor,
      templates,
      baseCtx,
      physicalStackName,
      ui,
    };

    // Terraform (aws-tf / azure-tf) opera no diretório inteiro — executa uma vez.
    if (effectiveProvider === 'terraform' || effectiveProvider === 'azure-tf') {
      const done = await destroyTerraformDir(flow, effectiveProvider);
      if (done) this.log(chalk.green(t('\nDestroy concluído.', '\nDestroy complete.')));
      return;
    }

    let totalResources = 0;
    const stackNames: string[] = [];
    for (const t of templates) {
      totalResources += countResources(t.filePath, provider);
      stackNames.push(t.stackName);
    }

    this.log(t(`Stacks a destruir: ${stackNames.join(', ')}`, `Stacks to destroy: ${stackNames.join(', ')}`));
    this.log(t(`Total de recursos: ${totalResources} em ${provider.toUpperCase()}`, `Total resources: ${totalResources} on ${provider.toUpperCase()}`));
    this.log('');

    if (!flags.force && !dryRun) {
      const confirmed = await confirm(t('Tem certeza que deseja destruir esses recursos?', 'Are you sure you want to destroy these resources?'));
      if (!confirmed) {
        this.log(t('Operação cancelada.', 'Operation cancelled.'));
        return;
      }
    }

    if (!dryRun && !commandExists(executor.requiredBinary)) {
      this.error(t(`${executor.requiredBinary} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`, `${executor.requiredBinary} not found in PATH. Run: iacmp doctor --fix (or install it manually) and try again.`));
    }

    // APIM soft-deleted: captura os vivos ANTES do delete para purgar depois.
    const apimsToPurge = provider === 'azure' && !dryRun && config.resourceGroup
      ? captureApimsToPurge(config.resourceGroup)
      : [];

    // Deployment único Azure (_main.bicep): ver deploy/flows/destroy-azure-main.ts.
    if (provider === 'azure' && fs.existsSync(path.join(providerOutDir(cwd, 'azure'), AZURE_MAIN_FILE))) {
      const done = await destroyAzureMain(flow, apimsToPurge);
      if (done) this.log(chalk.green(t('\nDestroy concluído.', '\nDestroy complete.')));
      return;
    }

    // Destroy por stack: ver deploy/flows/destroy-stacks.ts.
    await destroyStackLoop(flow);

    if (!dryRun) fireApimPurge(apimsToPurge, ui);
    if (!dryRun && provider === 'azure' && config.resourceGroup) {
      await maybeDeleteEmptyRg(config.resourceGroup, flags.force, ui);
    }
    if (!dryRun && provider === 'aws') {
      await maybePurgeRetainedBuckets(templates.map(t => t.filePath), region, flags.force, ui);
    }
    this.log(chalk.green(t('Destroy concluído.', 'Destroy complete.')));
  }
}
