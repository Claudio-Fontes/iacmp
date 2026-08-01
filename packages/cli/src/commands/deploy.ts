import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { t } from '../i18n';
import { listTemplates, orderByDependency, providerOutDir, AZURE_MAIN_FILE } from '../synth-out';
import { errMessage, loadIacmpConfig, resolveProvider, resolveProviderRegion, IacmpConfig } from '../utils';
import { commandExists } from './doctor';
import { getExecutor, DeployContext } from '../deploy';
import { maybeLearn } from '../learn';
import { loadStacks } from '../audit';
import { tierWarnings, AccountTier } from '../deploy/resource-tier-map';
import { confirm, DeployUI, DeployFlowOptions } from '../deploy/flows/common';
import { ensureAzureResourceGroup } from '../deploy/flows/azure-rg';
import { deployAzureMain } from '../deploy/flows/azure-main';
import { deployTerraformDir } from '../deploy/flows/terraform';
import { deployStackLoop } from '../deploy/flows/stacks';

export default class Deploy extends Command {
  static description = t('Faz deploy das stacks no provider configurado', 'Deploys the stacks to the configured provider');

  static flags = {
    provider: Flags.string({ char: 'p', description: t('Provider alvo (aws, azure, gcp) — default: o provider do iacmp.json', 'Target provider (aws, azure, gcp) — default: the provider from iacmp.json') }),
    stack: Flags.string({ char: 's', description: t('Nome da stack específica', 'Name of a specific stack') }),
    format: Flags.string({ options: ['tf'], description: t('Formato de deploy: tf = usa Terraform em vez do deployer nativo. Para Azure requer synth --format tf prévio.', 'Deploy format: tf = use Terraform instead of the native deployer. For Azure, requires a prior synth --format tf.') }),
    'dry-run': Flags.boolean({ description: t('Mostra os comandos que seriam executados, sem rodar nada', 'Shows the commands that would run, without executing anything'), default: false }),
    yes: Flags.boolean({ char: 'y', description: t('Responde sim a todas as confirmações (apagar recurso órfão, criar resource group). Obrigatório para confirmações destrutivas em stdin não-interativo.', 'Answers yes to every confirmation (delete orphaned resource, create resource group). Required for destructive confirmations on non-interactive stdin.'), default: false }),
  };

  static examples = [
    '$ iacmp deploy',
    '$ iacmp deploy --provider aws --stack minha-stack',
    '$ iacmp deploy --provider azure',
    '$ iacmp deploy --provider gcp',
    // '$ iacmp deploy --provider terraform',  // desabilitado — use --provider aws --format tf
    '$ iacmp deploy --dry-run',
    '$ iacmp deploy --yes',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
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
    // --format tf redireciona AWS → executor terraform (synth-out/aws-tf/)
    //             e Azure → executor azure-tf (synth-out/azure-tf/)
    const effectiveProvider =
      flags.format === 'tf' && provider === 'aws' ? 'terraform' :
      flags.format === 'tf' && provider === 'azure' ? 'azure-tf' :
      provider;
    const region = resolveProviderRegion(provider, config);

    // Aviso de tier/disponibilidade também no deploy (não só synth/ai) — cobre o
    // deploy direto sem re-synth. Só avisa; falha ao carregar as stacks é ignorada
    // (o deploy opera sobre os templates já sintetizados).
    if (provider === 'aws' || provider === 'azure') {
      try {
        const tier = (config.accountTier as AccountTier) ?? 'free';
        const constructTypes = loadStacks(cwd).flatMap(s => s.stack.constructs.map(c => c.type));
        for (const w of tierWarnings(constructTypes, provider, tier)) this.warn(w);
      } catch { /* stacks não carregam — segue */ }
    }

    let executor;
    try {
      executor = getExecutor(effectiveProvider);
    } catch (err) {
      this.error(errMessage(err));
    }

    if ((effectiveProvider === 'terraform' || effectiveProvider === 'azure-tf') && flags.stack) {
      this.error(t('--stack não é suportado com --format tf — deploy/destroy operam no diretório terraform inteiro (todas as stacks compartilham um state).', '--stack is not supported with --format tf — deploy/destroy operate on the whole terraform directory (all stacks share one state).'));
    }

    // Confere se há algo sintetizado antes de checar CLI/credenciais — "rode
    // iacmp synth" é o fix mais provável e não deveria depender do ambiente.
    // orderByDependency garante que uma stack que EXPORTA (ex: Function.Lambda
    // referenciada por outra stack via Fn::ImportValue) suba antes de quem
    // importa — sem isso o deploy real falharia com "export not found".
    const allTemplates = orderByDependency(listTemplates(cwd, effectiveProvider));
    const templates = flags.stack ? allTemplates.filter(t => t.stackName === flags.stack) : allTemplates;
    if (templates.length === 0) {
      const hint = flags.format === 'tf' ? ` --format tf` : '';
      this.error(t(`Nenhum template encontrado para '${effectiveProvider}'. Rode: iacmp synth --provider ${provider}${hint}`, `No template found for '${effectiveProvider}'. Run: iacmp synth --provider ${provider}${hint}`));
    }

    // --dry-run nunca chama a CLI nativa de verdade — não exige o binário
    // instalado, só mostra o plano (os helpers de leitura usados no plano
    // degradam graciosamente quando o binário está ausente).
    if (!dryRun && !commandExists(executor.requiredBinary)) {
      this.error(t(`${executor.requiredBinary} não encontrado no PATH. Rode: iacmp doctor --fix (ou instale manualmente) e tente novamente.`, `${executor.requiredBinary} not found in PATH. Run: iacmp doctor --fix (or install it manually) and try again.`));
    }

    const ui: DeployUI = {
      log: (msg) => this.log(msg),
      warn: (msg) => { this.warn(msg); },
      error: (msg) => this.error(msg),
    };

    // Nome físico da stack no CloudFormation = prefixado com o nome do projeto
    // para evitar colisões entre projetos distintos na mesma conta AWS.
    // Sem nome de projeto (config.name vazio ou ausente), comportamento idêntico
    // ao anterior (sem prefixo). O nome LÓGICO (t.stackName, do arquivo) continua
    // sendo usado para display e para filtro --stack.
    const physicalStackName = (logicalName: string): string => {
      const raw = config.name ? `${config.name}-${logicalName}` : logicalName;
      // CloudFormation exige [a-zA-Z][-a-zA-Z0-9]* — prefixo 'p-' se começar com dígito
      return /^\d/.test(raw) ? `p-${raw}` : raw;
    };

    const baseCtx: Omit<DeployContext, 'stackName' | 'templatePath'> = {
      cwd,
      region,
      resourceGroup: config.resourceGroup,
      projectId: config.projectId,
      dryRun,
      tfBackend: config.tfBackend,
    };

    const flow: DeployFlowOptions = {
      cwd,
      config,
      provider,
      region,
      dryRun,
      yes: flags.yes,
      stackFlag: flags.stack,
      executor,
      templates,
      allTemplates,
      baseCtx,
      physicalStackName,
      ui,
    };

    if (provider === 'azure' && effectiveProvider !== 'azure-tf') {
      await ensureAzureResourceGroup(flow);
    }

    this.log(`Provider: ${provider}${dryRun ? ' (dry-run)' : ''}\n`);

    // Terraform (aws-tf / azure-tf) opera no diretório inteiro como um state
    // único — uma única chamada ao executor, não um loop por stack.
    if (effectiveProvider === 'terraform' || effectiveProvider === 'azure-tf') {
      await deployTerraformDir(flow, effectiveProvider);
      this.log(chalk.green(t('\nDeploy concluído.', '\nDeploy complete.')));
      return;
    }

    // Deployment único (_main.bicep): ver deploy/flows/azure-main.ts.
    const azureMainPath = provider === 'azure'
      ? path.join(providerOutDir(cwd, 'azure'), AZURE_MAIN_FILE)
      : null;
    if (azureMainPath !== null && fs.existsSync(azureMainPath)) {
      await deployAzureMain(flow, azureMainPath);
      if (!dryRun) await this.afterDeploy(cwd, provider, config, flags.yes);
      this.log(chalk.green(t('\nDeploy concluído.', '\nDeploy complete.')));
      return;
    }

    // Deploy por stack (AWS / Azure legado / GCP): ver deploy/flows/stacks.ts.
    await deployStackLoop(flow);

    if (!dryRun) await this.afterDeploy(cwd, provider, config, flags.yes);
    this.log(chalk.green(t('Deploy concluído.', 'Deploy complete.')));
  }

  // Loop de aprendizado (Modo 1): oferece gravar o padrão deste deploy na base
  // LOCAL do cliente, se ele optou (`knowledge.autolearn: "local"`). No-op sem
  // opt-in. Nunca lança — o deploy já concluiu.
  private async afterDeploy(cwd: string, provider: string, config: IacmpConfig, yes: boolean): Promise<void> {
    await maybeLearn(cwd, provider, config, {
      log: (m) => this.log(m),
      confirm: yes ? async () => true : confirm,
      isTTY: !!process.stdin.isTTY,
      now: () => new Date().toISOString(),
    });
  }
}
