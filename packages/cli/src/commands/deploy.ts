import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';

const PROVIDER_LABELS: Record<string, string> = {
  aws: 'AWS (CloudFormation)',
  azure: 'Azure (ARM Template)',
  gcp: 'GCP (Deployment Manager)',
  terraform: 'Terraform',
};

function getResourceCount(templatePath: string, provider: string): number {
  const content = fs.readFileSync(templatePath, 'utf-8');

  if (provider === 'terraform') {
    const matches = content.match(/^resource\s+"/gm);
    return matches ? matches.length : 0;
  }

  const parsed = JSON.parse(content);

  if (provider === 'aws' || provider === 'azure') {
    if (Array.isArray(parsed.resources)) return parsed.resources.length;
    if (parsed.Resources) return Object.keys(parsed.Resources).length;
  }

  if (provider === 'gcp') {
    if (Array.isArray(parsed.resources)) return parsed.resources.length;
  }

  return 0;
}

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

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const provider = flags.provider ?? config.provider ?? 'aws';
    const label = PROVIDER_LABELS[provider] ?? provider.toUpperCase();

    this.log(`Sintetizando stacks para ${provider}...`);

    const outDir = path.join(cwd, 'synth-out');
    if (!fs.existsSync(outDir)) {
      this.error('Nenhum output de synth encontrado. Rode: iacmp synth');
    }

    const ext = provider === 'terraform' ? '.tf' : '.json';
    const templates = fs.readdirSync(outDir)
      .filter(f => f.endsWith(ext))
      .filter(f => !flags.stack || f.replace(ext, '') === flags.stack);

    if (templates.length === 0) {
      this.error(`Nenhum template encontrado em synth-out/. Rode: iacmp synth --provider ${provider}`);
    }

    let totalResources = 0;
    for (const file of templates) {
      const templatePath = path.join(outDir, file);
      const resourceCount = getResourceCount(templatePath, provider);
      totalResources += resourceCount;
      this.log(`  Stack: ${file.replace(ext, '')} — ${resourceCount} recurso(s)`);
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
