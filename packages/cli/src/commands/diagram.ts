import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { t } from '../i18n';
import { readConfig, loadStacks } from '../audit';
import { buildModel } from '../diagram/builder';
import { renderStructurizr } from '../diagram/structurizr';
import { renderMermaid } from '../diagram/mermaid';

const FORMATS = ['structurizr', 'mermaid'] as const;
type Format = typeof FORMATS[number];

const OUTPUT_FILE: Record<Format, string> = {
  structurizr: 'workspace.dsl',
  mermaid:     'workspace.md',
};

const STRUCTURIZR_PLAYGROUND_URL = 'https://structurizr.com/dsl';

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin'
      ? 'pbcopy'
      : process.platform === 'win32'
        ? 'clip'
        : 'xclip';
    const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
    const child = execFile(cmd, args, (err) => err ? reject(err) : resolve());
    child.stdin?.write(text);
    child.stdin?.end();
  });
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
    execFile(cmd, [url], (err) => err ? reject(err) : resolve());
  });
}

export default class Diagram extends Command {
  static description = t('Gera diagramas de arquitetura a partir das stacks do projeto.', 'Generates architecture diagrams from the project\'s stacks.');

  static flags = {
    format: Flags.string({
      char: 'f',
      description: t('Formato de saída: structurizr, mermaid', 'Output format: structurizr, mermaid'),
      default: 'structurizr',
    }),
    provider: Flags.string({
      char: 'p',
      description: t('Provider para o theme do diagrama: aws, azure, gcp, terraform (padrão: lido do iacmp.json)', 'Provider for the diagram theme: aws, azure, gcp, terraform (default: read from iacmp.json)'),
    }),
    stack: Flags.string({
      char: 's',
      description: t('Nome de uma stack específica (padrão: todas)', 'Name of a specific stack (default: all)'),
    }),
    out: Flags.string({
      char: 'o',
      description: t('Diretório de saída', 'Output directory'),
      default: 'diagrams',
    }),
    ha: Flags.boolean({
      description: t('Representa alta disponibilidade: replica a rede e o compute privado em duas AZs (AZ-A/AZ-B) na deployment view', 'Represents high availability: replicates the network and private compute across two AZs (AZ-A/AZ-B) in the deployment view'),
      default: false,
    }),
    open: Flags.boolean({
      description: t('Copia o DSL gerado para a área de transferência e abre o Structurizr Playground no navegador', 'Copies the generated DSL to the clipboard and opens the Structurizr Playground in the browser'),
      default: false,
    }),
  };

  static examples = [
    '$ iacmp diagram',
    '$ iacmp diagram --provider azure',
    '$ iacmp diagram --provider gcp',
    '$ iacmp diagram --format mermaid',
    '$ iacmp diagram --stack database',
    '$ iacmp diagram --provider azure --format mermaid',
    '$ iacmp diagram --provider aws --ha',
    '$ iacmp diagram --provider aws --open',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Diagram);
    const cwd = process.cwd();

    if (!FORMATS.includes(flags.format as Format)) {
      this.error(t(`Formato '${flags.format}' inválido. Use: ${FORMATS.join(', ')}`, `Invalid format '${flags.format}'. Use: ${FORMATS.join(', ')}`));
    }
    const format = flags.format as Format;

    let config;
    try {
      config = readConfig(cwd);
    } catch (err) {
      this.error((err as Error).message);
    }

    let allStacks;
    try {
      allStacks = loadStacks(cwd);
    } catch (err) {
      this.error((err as Error).message);
    }

    // Filtra pelo --stack quando informado
    const stacks = flags.stack
      ? allStacks.filter(s => s.name === flags.stack)
      : allStacks;

    if (stacks.length === 0) {
      this.error(flags.stack
        ? t(`Stack '${flags.stack}' não encontrada. Stacks disponíveis: ${allStacks.map(s => s.name).join(', ')}`, `Stack '${flags.stack}' not found. Available stacks: ${allStacks.map(s => s.name).join(', ')}`)
        : t('Nenhuma stack encontrada em stacks/', 'No stack found in stacks/'),
      );
    }

    // Constrói modelo intermediário — provider da flag sobrepõe o do iacmp.json
    const provider = flags.provider ?? config.provider;
    const model = buildModel(config.name, provider, 'us-east-1', stacks, flags.ha);

    // Renderiza
    const content = format === 'structurizr'
      ? renderStructurizr(model)
      : renderMermaid(model);

    // Escreve arquivo
    const outDir = path.join(cwd, flags.out);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, OUTPUT_FILE[format]);
    fs.writeFileSync(outFile, content, 'utf-8');

    const relOut = path.join(flags.out, OUTPUT_FILE[format]);

    this.log('');
    this.log(chalk.bold(t('Diagrama gerado', 'Diagram generated')));
    this.log('─'.repeat(40));
    this.log(t(`Projeto:  ${config.name}`, `Project:  ${config.name}`));
    this.log(`Provider: ${provider}${flags.provider ? ' (via --provider)' : ''}`);
    this.log(t(`Formato:  ${format}`, `Format:   ${format}`));
    if (flags.ha) this.log(t(`HA:       ${chalk.green('on')} (replicado em AZ-A/AZ-B)`, `HA:       ${chalk.green('on')} (replicated across AZ-A/AZ-B)`));
    this.log(`Stacks:   ${model.stacks.map(s => s.name).join(', ')}`);
    this.log(`Nodes:    ${model.stacks.reduce((n, s) => n + s.nodes.length, 0)}`);
    this.log('');

    for (const s of model.stacks) {
      this.log(t(`  ${chalk.green('✓')} ${s.name} — ${s.nodes.length} recurso(s)`, `  ${chalk.green('✓')} ${s.name} — ${s.nodes.length} resource(s)`));
      for (const node of s.nodes) {
        const desc = node.description ? chalk.dim(` — ${node.description}`) : '';
        this.log(`      ${node.label} ${chalk.dim(`(${node.constructType})`)}${desc}`);
      }
    }

    this.log('');
    this.log(t(`Arquivo salvo em ${chalk.cyan(relOut)}`, `File saved to ${chalk.cyan(relOut)}`));

    if (format === 'structurizr') {
      this.log(chalk.dim(t(`\nAbra em: ${STRUCTURIZR_PLAYGROUND_URL}`, `\nOpen at: ${STRUCTURIZR_PLAYGROUND_URL}`)));
    } else {
      this.log(chalk.dim(t('\nRenderizado automaticamente no GitHub, GitLab e Notion.', '\nRendered automatically on GitHub, GitLab and Notion.')));
    }

    if (flags.open) {
      if (format !== 'structurizr') {
        this.warn(t('A flag --open só tem efeito com --format structurizr.', 'The --open flag only has effect with --format structurizr.'));
      } else {
        try {
          await copyToClipboard(content);
          await openBrowser(STRUCTURIZR_PLAYGROUND_URL);
          this.log(chalk.dim(t('\nDSL copiado para a área de transferência. Cole (Cmd/Ctrl+V) no editor que abriu.', '\nDSL copied to the clipboard. Paste (Cmd/Ctrl+V) into the editor that opened.')));
        } catch (err) {
          this.warn(t(`Não foi possível abrir o navegador/copiar automaticamente: ${(err as Error).message}`, `Could not open the browser/copy automatically: ${(err as Error).message}`));
        }
      }
    }

    this.log('');
  }
}
