import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { listTemplates, countResources } from '../synth-out';
import { readJsonFile, errMessage } from '../utils';

const MVP_BANNER = 'MVP: deploy/destroy real ainda não implementado nesta fase. Os arquivos foram impressos como dry-run.';

const PROVIDER_LABELS: Record<string, string> = {
  aws: 'AWS (CloudFormation)',
  azure: 'Azure (ARM Template)',
  gcp: 'GCP (Deployment Manager)',
  terraform: 'Terraform',
};

export default class Deploy extends Command {
  static description = 'Faz deploy das stacks no provider configurado';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform)', default: 'aws' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
  };

  static examples = [
    '$ iacmp deploy',
    '$ iacmp deploy --provider aws --stack minha-stack',
    '$ iacmp deploy --provider azure',
    '$ iacmp deploy --provider gcp',
    '$ iacmp deploy --provider terraform',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Deploy);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    let config: { provider?: string };
    try {
      config = readJsonFile<{ provider?: string }>(configPath);
    } catch (err) {
      this.error(errMessage(err));
    }
    const provider = flags.provider ?? config.provider ?? 'aws';
    const label = PROVIDER_LABELS[provider] ?? provider.toUpperCase();

    this.log(chalk.yellow.bold(MVP_BANNER));
    this.log('');
    this.log(`Sintetizando stacks para ${provider}...`);

    const templates = listTemplates(cwd, provider, flags.stack);

    if (templates.length === 0) {
      this.error(`Nenhum template encontrado para '${provider}'. Rode: iacmp synth --provider ${provider}`);
    }

    let totalResources = 0;
    for (const t of templates) {
      const resourceCount = countResources(t.filePath, provider);
      totalResources += resourceCount;
      this.log(`  Stack: ${t.stackName} — ${resourceCount} recurso(s)`);
    }

    this.log('');

    if (provider === 'terraform') {
      this.log(`Would apply ${totalResources} resource(s) (Terraform)`);
    } else {
      this.log(`Would deploy ${totalResources} resource(s) to ${label}`);
    }

    this.log('');
    this.log('(MVP: deploy real não implementado nesta fase)');
  }
}
