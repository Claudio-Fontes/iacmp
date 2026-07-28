import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { loadIacmpConfig, resolveProvider, profileFromConfig } from '../utils';
import { loadPlugins } from '@iacmp/plugin-sdk';
import { synthRoot, providerOutDir, templateExt } from '../synth-out';
import { LoadedStack } from '../validators';
import { SynthUI } from '../synth/types';
import { loadProjectStacks } from '../synth/stack-loader';
import { runSynthGuards } from '../synth/guards';
import { synthAws } from '../synth/aws';
import { synthAzure } from '../synth/azure';
import { synthGcp } from '../synth/gcp';
import { synthAwsTf } from '../synth/aws-tf';
import { synthAzureTf } from '../synth/azure-tf';

export default class Synth extends Command {
  static description = 'Sintetiza as stacks para o formato nativo do provider';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp) — default: o provider do iacmp.json' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
    format: Flags.string({ options: ['tf'], description: 'Formato de saída alternativo: tf = Terraform (tf.json). Para AWS redireciona para o pipeline terraform existente; para Azure gera provider azurerm; para GCP é noop (já é tf.json nativamente).' }),
  };

  static examples = [
    '$ iacmp synth',
    '$ iacmp synth --provider aws',
    '$ iacmp synth --provider azure',
    '$ iacmp synth --provider gcp',
    // '$ iacmp synth --provider terraform',  // desabilitado — use --provider aws --format tf
    '$ iacmp synth --stack minha-stack',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Synth);
    const cwd = process.cwd();
    const config = loadIacmpConfig(cwd);

    if (!config) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    const provider = resolveProvider(config, flags.provider);
    const profile = profileFromConfig(config);
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.error('Diretório stacks/ não encontrado.');
    }

    const nativeProviders = ['aws', 'azure', 'gcp']; // 'terraform' desabilitado — use --provider aws --format tf
    const pluginProviders = loadPlugins(cwd);
    const pluginProvider = pluginProviders.find(p => p.name === provider);

    if (!nativeProviders.includes(provider) && !pluginProvider) {
      this.error(`Provider '${provider}' não encontrado. Providers disponíveis: ${nativeProviders.join(', ')}`);
    }

    const ui: SynthUI = {
      log: (msg) => this.log(msg),
      warn: (msg) => { this.warn(msg); },
      error: (msg) => this.error(msg),
    };

    const loadedStacks = loadProjectStacks(cwd, stacksDir, ui);
    runSynthGuards(loadedStacks, cwd, provider, config, ui);

    const targetStacks = loadedStacks.filter(s => !flags.stack || s.stackName === flags.stack);
    if (targetStacks.length === 0) {
      this.error('Nenhuma stack encontrada em stacks/');
    }

    const outDir = synthRoot(cwd);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const allStacks = loadedStacks.map(s => s.stack);

    // ── --format tf: saída Terraform alternativa (aditiva, não substitui nativo) ─
    // AWS → synth/aws-tf.ts (synth-out/aws-tf/)
    // Azure → synth/azure-tf.ts (provider azurerm, synth-out/azure-tf/)
    // GCP → noop (já é tf.json nativamente)
    if (flags.format === 'tf') {
      if (provider === 'gcp') {
        this.warn('--format tf ignorado: GCP já usa Terraform nativamente.');
      } else if (provider === 'aws') {
        synthAwsTf({ cwd, targetStacks, allStacks, profile, ui });
        return;
      } else if (provider === 'azure') {
        synthAzureTf({ cwd, targetStacks, allStacks, config, ui });
        return;
      }
    }

    // Remove stale templates do synth-out (de stacks que não existem mais).
    // Só quando synth é completo (sem --stack) — synth parcial pode deixar
    // arquivos de outras stacks intencionalmente.
    if (!flags.stack) {
      this.cleanupStaleTemplates(cwd, provider, loadedStacks);
    }

    switch (provider) {
      case 'aws':
        synthAws({ cwd, targetStacks, allStacks, profile, projectName: config.name || undefined, stackFlag: flags.stack, ui });
        break;

      case 'azure':
        synthAzure({ cwd, targetStacks, allStacks, config, stackFlag: flags.stack, ui });
        break;

      case 'gcp':
        synthGcp({ cwd, targetStacks, allStacks, ui });
        break;

      default: {
        if (pluginProvider) {
          const provOutDir = providerOutDir(cwd, provider);
          fs.mkdirSync(provOutDir, { recursive: true });
          for (const { stackName, stack } of targetStacks) {
            try {
              const output = pluginProvider.synthesize(stack);
              const outPath = path.join(provOutDir, `${stackName}.json`);
              fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
              this.log(`Sintetizado via plugin '${provider}': ${outPath}`);
            } catch (err) {
              this.error(`Falha ao sintetizar '${stackName}': ${(err as Error).message}`);
            }
          }
        }
        break;
      }
    }
  }

  private cleanupStaleTemplates(cwd: string, provider: string, loadedStacks: LoadedStack[]): void {
    const provOutDir = providerOutDir(cwd, provider);
    const ext = templateExt(provider);
    if (!fs.existsSync(provOutDir)) return;
    const currentNames = new Set(loadedStacks.map(s => s.stackName));
    for (const file of fs.readdirSync(provOutDir)) {
      if (!file.endsWith(ext)) continue;
      // Arquivos prefixados com "_" não representam uma stack — são
      // compartilhados do projeto inteiro (ex: gcp `_providers.tf.json`,
      // azure `_main.bicep`). Nunca "stale".
      if (file.startsWith('_')) continue;
      const stale = file.slice(0, -ext.length);
      if (!currentNames.has(stale)) {
        fs.rmSync(path.join(provOutDir, file));
        // Remove também o .iacmp-meta.json correspondente, se existir
        const meta = path.join(provOutDir, `${stale}.iacmp-meta.json`);
        if (fs.existsSync(meta)) fs.rmSync(meta);
      }
    }
  }
}
