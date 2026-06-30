import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { AWSProvider } from '@iacmp/provider-aws';
import { AzureProvider } from '@iacmp/provider-azure';
import { GCPProvider } from '@iacmp/provider-gcp';
import { TerraformProvider } from '@iacmp/provider-terraform';
import { Stack, EnvironmentProfile, AccountTier, tsCompilerOptions } from '@iacmp/core';
import { loadPlugins } from '@iacmp/plugin-sdk';
import { synthRoot, providerOutDir } from '../synth-out';

interface LoadedStack {
  stackName: string;
  stack: Stack;
}

export default class Synth extends Command {
  static description = 'Sintetiza as stacks para o formato nativo do provider';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform)', default: 'aws' }),
    stack: Flags.string({ char: 's', description: 'Nome da stack específica' }),
  };

  static examples = [
    '$ iacmp synth',
    '$ iacmp synth --provider aws',
    '$ iacmp synth --provider azure',
    '$ iacmp synth --provider gcp',
    '$ iacmp synth --provider terraform',
    '$ iacmp synth --stack minha-stack',
  ];

  async run(): Promise<void> {
    const { flags } = await this.parse(Synth);
    const cwd = process.cwd();
    const configPath = path.join(cwd, 'iacmp.json');

    if (!fs.existsSync(configPath)) {
      this.error('Projeto não inicializado. Rode: iacmp init');
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const provider = flags.provider ?? config.provider ?? 'aws';
    const profile: EnvironmentProfile = {
      accountTier: (config.accountTier === 'standard' ? 'standard' : 'free') as AccountTier,
      region: config.region,
      availabilityZones: config.availabilityZones,
    };
    const stacksDir = path.join(cwd, 'stacks');

    if (!fs.existsSync(stacksDir)) {
      this.error('Diretório stacks/ não encontrado.');
    }

    const findStackFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findStackFiles(full));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          files.push(full);
        }
      }
      return files;
    };

    const nativeProviders = ['aws', 'azure', 'gcp', 'terraform'];
    const pluginProviders = loadPlugins(cwd);
    const pluginProvider = pluginProviders.find(p => p.name === provider);

    if (!nativeProviders.includes(provider) && !pluginProvider) {
      this.error(`Provider '${provider}' não encontrado. Providers disponíveis: ${nativeProviders.join(', ')}`);
    }

    // ── Passada 1: carrega TODAS as stacks de stacks/ (ignora --stack) ──────
    // A resolução de referências entre stacks (ex: Function.ApiGateway numa
    // stack referenciando Function.Lambda de outra) precisa de visão do
    // projeto inteiro, mesmo quando o usuário só quer sintetizar uma stack.
    const allStackFiles = findStackFiles(stacksDir);
    const loadedStacks: LoadedStack[] = [];
    const loadErrors: string[] = [];

    for (const stackPath of allStackFiles) {
      const file = path.basename(stackPath);
      const stackName = file.replace(/\.(ts|js)$/, '');

      let stackModule: Record<string, unknown>;
      try {
        // .ts: registra ts-node se disponível no projeto do usuário e carrega diretamente
        if (file.endsWith('.ts')) {
          const tsNodePath = this.resolveTsNode(cwd);
          if (tsNodePath) {
            require(tsNodePath).register({
              transpileOnly: true,
              skipProject: true,
              compilerOptions: tsCompilerOptions(cwd),
            });
          } else {
            this.warn(`ts-node não encontrado em ${cwd}/node_modules. Rode: npm install`);
            continue;
          }
        }
        stackModule = require(stackPath) as Record<string, unknown>;
      } catch (err) {
        // Erro de compilação/sintaxe num stack é FALHA, não warning — antes o
        // arquivo sumia silenciosamente do output e o loop de validação da IA
        // achava que estava tudo certo (via "Synth validado" com exit 0).
        loadErrors.push(`${file}: ${(err as Error).message}`);
        continue;
      }

      const stack = stackModule.default ?? stackModule.stack ?? stackModule;
      if (!stack || typeof stack !== 'object' || !('constructs' in stack)) {
        this.warn(`${file} não exporta uma Stack válida. Exporte a stack como default.`);
        continue;
      }

      loadedStacks.push({ stackName, stack: stack as Stack });
    }

    if (loadErrors.length > 0) {
      this.error(
        `Falha ao carregar ${loadErrors.length} stack(s) — corrija os erros de compilação:\n\n` +
        loadErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    if (loadedStacks.length === 0) {
      this.error('Nenhuma stack encontrada em stacks/');
    }

    // ── Validação handler ↔ arquivo de origem ───────────────────────────────
    // Um Fn.Lambda com handler 'dist/listItems.handler' precisa de src/listItems.ts
    // (que compila para dist/listItems.js). Sem isso, o deploy falha em runtime
    // com "Cannot find module". Pega o descompasso aqui, em synth-time.
    const handlerErrors = this.validateHandlerFiles(loadedStacks, cwd);
    if (handlerErrors.length > 0) {
      this.error(
        `Handler(s) de Lambda sem arquivo de origem correspondente:\n\n` +
        handlerErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Validação de SQL nos handlers (src/) ────────────────────────────────
    // Pega INSERT com contagem de colunas != valores — bug recorrente da IA que
    // só apareceria em runtime ("INSERT has more target columns than expressions").
    const sqlErrors = this.validateHandlerSql(cwd);
    if (sqlErrors.length > 0) {
      this.error(
        `SQL inválido em handler(s):\n\n` + sqlErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Passada 2: sintetiza e grava só as stacks que o --stack pediu ───────
    const targetStacks = loadedStacks.filter(s => !flags.stack || s.stackName === flags.stack);
    if (targetStacks.length === 0) {
      this.error('Nenhuma stack encontrada em stacks/');
    }

    const outDir = synthRoot(cwd);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const allStacks = loadedStacks.map(s => s.stack);

    for (const { stackName, stack: typedStack } of targetStacks) {
      // Subdiretório por provider (synth-out/<provider>/) para evitar sobrescrita
      // entre providers. Os comandos consumidores resolvem este mesmo caminho via
      // o módulo synth-out.
      const provOutDir = providerOutDir(cwd, provider);
      fs.mkdirSync(provOutDir, { recursive: true });

      try {
        switch (provider) {
          case 'aws': {
            const p = new AWSProvider();
            const template = p.synthesize(typedStack, allStacks, profile);
            const outPath = path.join(provOutDir, `${stackName}.json`);
            fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'azure': {
            const p = new AzureProvider();
            const template = p.synthesize(typedStack, allStacks);
            const outPath = path.join(provOutDir, `${stackName}.json`);
            fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'gcp': {
            const p = new GCPProvider();
            const deployment = p.synthesize(typedStack, allStacks);
            const outPath = path.join(provOutDir, `${stackName}.json`);
            fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + '\n');
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'terraform': {
            const p = new TerraformProvider();
            const hcl = p.synthesize(typedStack, allStacks);
            const outPath = path.join(provOutDir, `${stackName}.tf`);
            fs.writeFileSync(outPath, hcl);
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          default: {
            if (pluginProvider) {
              const output = pluginProvider.synthesize(typedStack);
              const outPath = path.join(provOutDir, `${stackName}.json`);
              fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
              this.log(`Sintetizado via plugin '${provider}': ${outPath}`);
            }
            break;
          }
        }
      } catch (err) {
        this.error(`Falha ao sintetizar '${stackName}': ${(err as Error).message}`);
      }
    }
  }

  /**
   * Para cada Fn.Lambda com runtime Node, confirma que existe um arquivo de
   * origem correspondente ao `handler`. Convenção: `handler: '<dir>/<arquivo>.<export>'`
   * (ou `'<arquivo>.<export>'`) → o código vem de `src/<arquivo>.ts`, que compila
   * para `dist/<arquivo>.js`. Se nem o fonte nem o compilado existem, o deploy
   * falharia em runtime com "Cannot find module".
   */
  private validateHandlerFiles(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    // code props que seguem a convenção src/→dist/ (raiz do projeto ou dist/).
    const CONVENTION_CODE = new Set(['.', './', 'dist', 'dist/', './dist', './dist/', 'src', 'src/', './src', './src/']);

    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Function.Lambda') continue;
        const props = c.props as Record<string, unknown>;
        const runtime = (props.runtime as string) ?? 'nodejs20';
        if (!runtime.startsWith('nodejs')) continue; // só Node por ora
        const handler = props.handler as string | undefined;
        const code = props.code as string | undefined;
        if (!handler || typeof code !== 'string') continue;
        if (!CONVENTION_CODE.has(code)) continue; // code aponta pra outro lugar — não inferimos

        // 'dist/listItems.handler' → módulo 'dist/listItems' → stem 'listItems'
        const modulePath = handler.replace(/\.[^./]+$/, ''); // tira o .export final
        const stem = modulePath.replace(/^(\.\/)?(dist|src)\//, '');

        const candidates = [
          path.join(cwd, 'src', `${stem}.ts`),
          path.join(cwd, 'src', `${stem}.js`),
          path.join(cwd, 'dist', `${stem}.js`),
          path.join(cwd, `${modulePath}.js`),
          path.join(cwd, `${modulePath}.ts`),
        ];
        if (!candidates.some(p => fs.existsSync(p))) {
          errors.push(
            `Fn.Lambda "${c.id}": handler '${handler}' não tem origem — esperado src/${stem}.ts. ` +
            `Crie o arquivo do handler ou ajuste o campo handler.`,
          );
        }
      }
    }
    return errors;
  }

  /**
   * Varre src/**.ts por INSERTs com contagem de colunas != valores — bug comum
   * em handlers gerados (ex: INSERT INTO items (a,b,c) VALUES ($1,$2)). Só sinaliza
   * o caso single-line inequívoco para não gerar falso positivo (multi-row,
   * subquery, multi-linha são ignorados).
   */
  private validateHandlerSql(cwd: string): string[] {
    const errors: string[] = [];
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) return errors;

    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) tsFiles.push(full);
      }
    };
    walk(srcDir);

    // INSERT INTO <tabela> (col1, col2, ...) VALUES (v1, v2, ...) — uma linha.
    const re = /INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi;
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const cols = m[1].split(',').map(x => x.trim()).filter(Boolean);
        const vals = m[2].split(',').map(x => x.trim()).filter(Boolean);
        // Só sinaliza VALUES com placeholders simples ($n ou ?) — evita falso
        // positivo com funções/expressões que possam ter vírgulas internas.
        const simpleVals = vals.every(v => /^(\$\d+|\?)$/.test(v));
        if (simpleVals && cols.length !== vals.length) {
          errors.push(
            `${path.relative(cwd, file)}: INSERT com ${cols.length} coluna(s) (${cols.join(', ')}) ` +
            `mas ${vals.length} valor(es) (${vals.join(', ')}). A contagem deve bater.`,
          );
        }
      }
    }
    return errors;
  }

  private resolveTsNode(projectDir: string): string | null {
    return this.resolveModule(projectDir, 'ts-node');
  }

  // Busca um módulo em node_modules do projeto e de diretórios pai (monorepo).
  private resolveModule(projectDir: string, moduleName: string): string | null {
    let dir = projectDir;
    for (let i = 0; i < 5; i++) {
      const modPath = path.join(dir, 'node_modules', moduleName);
      if (fs.existsSync(modPath)) return modPath;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }
}
