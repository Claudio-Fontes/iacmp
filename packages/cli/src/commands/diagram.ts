import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
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

export default class Diagram extends Command {
  static description = 'Gera diagramas de arquitetura a partir das stacks do projeto';

  static flags = {
    format: Flags.string({
      char: 'f',
      description: 'Formato de saída: structurizr, mermaid',
      default: 'structurizr',
    }),
    stack: Flags.string({
      char: 's',
      description: 'Nome de uma stack específica (padrão: todas)',
    }),
    out: Flags.string({
      char: 'o',
      description: 'Diretório de saída',
      default: 'diagrams',
    }),
  };

  static examples = [
    '$ iacmp diagram',
    '$ iacmp diagram --format mermaid',
    '$ iacmp diagram --stack database',
    '$ iacmp diagram --format mermaid --stack webapp --out docs/diagrams',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Diagram);
    const cwd = process.cwd();

    if (!FORMATS.includes(flags.format as Format)) {
      this.error(`Formato '${flags.format}' inválido. Use: ${FORMATS.join(', ')}`);
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
        ? `Stack '${flags.stack}' não encontrada. Stacks disponíveis: ${allStacks.map(s => s.name).join(', ')}`
        : 'Nenhuma stack encontrada em stacks/',
      );
    }

    // Constrói modelo intermediário
    const model = buildModel(config.name, config.provider, 'us-east-1', stacks);

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
    this.log(chalk.bold('Diagrama gerado'));
    this.log('─'.repeat(40));
    this.log(`Projeto:  ${config.name}`);
    this.log(`Provider: ${config.provider}`);
    this.log(`Formato:  ${format}`);
    this.log(`Stacks:   ${stacks.map(s => s.name).join(', ')}`);
    this.log(`Nodes:    ${model.stacks.reduce((n, s) => n + s.nodes.length, 0)}`);
    this.log('');

    for (const s of model.stacks) {
      this.log(`  ${chalk.green('✓')} ${s.name} — ${s.nodes.length} recurso(s)`);
      for (const node of s.nodes) {
        const desc = node.description ? chalk.dim(` — ${node.description}`) : '';
        this.log(`      ${node.label} ${chalk.dim(`(${node.constructType})`)}${desc}`);
      }
    }

    this.log('');
    this.log(`Arquivo salvo em ${chalk.cyan(relOut)}`);

    if (format === 'structurizr') {
      this.log(chalk.dim('\nAbra em: https://structurizr.com/dsl'));
    } else {
      this.log(chalk.dim('\nRenderizado automaticamente no GitHub, GitLab e Notion.'));
    }
    this.log('');
  }
}
