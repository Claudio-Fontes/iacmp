import { Command, Flags } from '@oclif/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AWSProvider } from '@iacmp/provider-aws';
import { AzureProvider } from '@iacmp/provider-azure';
import { GCPProvider } from '@iacmp/provider-gcp';
import { TerraformProvider } from '@iacmp/provider-terraform';
import { Stack, EnvironmentProfile, AccountTier, tsCompilerOptions } from '@iacmp/core';
import { loadPlugins } from '@iacmp/plugin-sdk';
import { synthRoot, providerOutDir, templateExt, listTemplates, orderByDependency } from '../synth-out';

interface LoadedStack {
  stackName: string;
  stack: Stack;
}

export default class Synth extends Command {
  static description = 'Sintetiza as stacks para o formato nativo do provider';

  static flags = {
    provider: Flags.string({ char: 'p', description: 'Provider alvo (aws, azure, gcp, terraform) — default: o provider do iacmp.json' }),
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

    // ── Handler de Lambda-em-VPC usando Secrets Manager em runtime ──────────
    // Lambda em subnet privada não alcança o Secrets Manager (serviço fora da
    // VPC) sem NAT/VPC endpoint — o SDK pendura e a função dá timeout de 30s
    // (Service Unavailable). A senha do banco já vem resolvida na env DB_PASSWORD.
    const vpcSecretErrors = this.validateHandlerVpcSecrets(loadedStacks, cwd);
    if (vpcSecretErrors.length > 0) {
      this.error(
        `Handler de Lambda em VPC acessa Secrets Manager em runtime (vai dar timeout no deploy):\n\n` +
        vpcSecretErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler acessando DynamoDB como SQL ─────────────────────────────────
    // A IA às vezes gera pg/mysql + SELECT/INSERT para um projeto que só tem
    // DynamoDB. DynamoDB não é SQL — trava em runtime. Bloqueia em synth-time.
    const dynamoSqlErrors = this.validateHandlerDynamoNoSql(loadedStacks, cwd);
    if (dynamoSqlErrors.length > 0) {
      this.error(
        `Handler acessa DynamoDB como banco SQL (vai falhar em runtime):\n\n` +
        dynamoSqlErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Lambda-em-VPC acessando DynamoDB/S3 sem Gateway VPC Endpoint ─────────
    // Subnet privada sem NAT não alcança serviços da AWS fora da VPC; o SDK
    // pendura e a Lambda dá timeout. Gateway Endpoint (grátis) resolve.
    const gatewayEndpointErrors = this.validateLambdaVpcGatewayEndpoint(loadedStacks, cwd);
    if (gatewayEndpointErrors.length > 0) {
      this.error(
        `Lambda em VPC acessa serviço AWS sem Gateway VPC Endpoint (vai dar timeout no deploy):\n\n` +
        gatewayEndpointErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler pg sem ssl contra RDS PostgreSQL ─────────────────────────────
    // RDS Postgres 14+ exige conexão encriptada (pg_hba: "no encryption").
    // Handler com pg.Client sem `ssl:` falha TODO request em runtime.
    const pgSslErrors = this.validateHandlerPgSsl(loadedStacks, cwd);
    if (pgSslErrors.length > 0) {
      this.error(
        `Handler conecta no PostgreSQL sem SSL (RDS rejeita com "no pg_hba.conf entry ... no encryption"):\n\n` +
        pgSslErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler lê process.env.X que o construct não declara ─────────────────
    // A IA gera o handler certo mas ESQUECE o environment no Fn.Lambda — o CRUD
    // inteiro falha em runtime (ex: TABLE_NAME undefined → 502). Barrar aqui dá
    // um erro que o loop de auto-correção da geração consegue consertar.
    const envVarErrors = this.validateHandlerEnvVars(loadedStacks, cwd);
    if (envVarErrors.length > 0) {
      this.error(
        `Handler usa process.env que o Fn.Lambda não declara em 'environment' (vai falhar em runtime):\n\n` +
        envVarErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Validação GSI: handler consulta índice que a tabela não declara ─────
    // A IA gera um handler com QueryCommand({ IndexName: 'TTLIndex' }) mas a
    // Database.DynamoDB sai sem esse globalSecondaryIndexes. Deploya, mas a query
    // falha em runtime (ValidationException: table does not have index). Barrar
    // aqui dá ao loop de auto-correção o gatilho para consertar.
    const gsiErrors = this.validateHandlerDynamoGsi(loadedStacks, cwd);
    if (gsiErrors.length > 0) {
      this.error(
        `Handler consulta um GSI que a tabela DynamoDB não declara (ValidationException em runtime):\n\n` +
        gsiErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Validação nomes reservados DynamoDB em expressões (sem alias '#') ────
    // FilterExpression: 'ttl < :now' → 'ttl' é reserved keyword → ValidationException
    // em runtime. Forçar o alias '#ttl' aqui dá o gatilho pro loop se auto-corrigir.
    const reservedErrors = this.validateHandlerDynamoReservedWords(loadedStacks, cwd);
    if (reservedErrors.length > 0) {
      this.error(
        `Handler usa nome reservado do DynamoDB cru numa expressão (ValidationException em runtime):\n\n` +
        reservedErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── DB_USER hardcoded em vez de ref('<Db>','Username') ──────────────────
    // A IA crava DB_USER: 'postgres' (default óbvio) na env do Fn.Lambda, mas o
    // admin real do Database.SQL varia por cloud (AWS/Azure = 'dbadmin'). Deploya,
    // mas a auth do banco falha em runtime ("password authentication failed for
    // user postgres"). Só ref('<Db>','Username') resolve pro admin certo de cada cloud.
    const dbUserErrors = this.validateDbUserRef(loadedStacks);
    if (dbUserErrors.length > 0) {
      this.error(
        `DB_USER hardcoded no Fn.Lambda (a auth do banco falha em runtime):\n\n` +
        dbUserErrors.map(e => `  • ${e}`).join('\n'),
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

    // Remove stale templates do synth-out (de stacks que não existem mais).
    // Só quando synth é completo (sem --stack) — synth parcial pode deixar
    // arquivos de outras stacks intencionalmente.
    if (!flags.stack) {
      const provOutDir = providerOutDir(cwd, provider);
      const ext = templateExt(provider);
      if (fs.existsSync(provOutDir)) {
        const currentNames = new Set(loadedStacks.map(s => s.stackName));
        for (const file of fs.readdirSync(provOutDir)) {
          if (!file.endsWith(ext)) continue;
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
            const template = p.synthesize(typedStack, allStacks, profile, config.name || undefined);
            const outPath = path.join(provOutDir, `${stackName}.json`);
            fs.writeFileSync(outPath, JSON.stringify(template, null, 2) + '\n');
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'azure': {
            const p = new AzureProvider();
            const bicep = p.synthesize(typedStack, allStacks, { accountTier: (config.accountTier === 'standard' ? 'standard' : 'free') });
            const outPath = path.join(provOutDir, `${stackName}.bicep`);
            fs.writeFileSync(outPath, bicep);
            const { extractAzureFunctionMeta } = await import('@iacmp/provider-azure');
            const fnMeta = extractAzureFunctionMeta(typedStack, allStacks);
            if (fnMeta.length > 0) {
              fs.writeFileSync(
                path.join(provOutDir, `${stackName}.iacmp-meta.json`),
                JSON.stringify({ functions: fnMeta }, null, 2),
              );
            }
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'gcp': {
            const p = new GCPProvider();
            const tfJson = p.synthesize(typedStack, allStacks);
            const outPath = path.join(provOutDir, `${stackName}.tf.json`);
            fs.writeFileSync(outPath, tfJson);
            this.log(`Sintetizado: ${outPath}`);
            break;
          }

          case 'terraform': {
            const p = new TerraformProvider();
            const tfJson = p.synthesize(typedStack, allStacks, profile);
            const outPath = path.join(provOutDir, `${stackName}.tf.json`);
            fs.writeFileSync(outPath, tfJson);
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

    // ── Detecção de dependência circular cross-stack (AWS + Azure) ──────────
    // Roda pós-synth (templates já em disco) mas pré-deploy. Se duas ou mais
    // stacks importam exports uma da outra — ex: buckets-stack exporta
    // BucketArn e importa Lambda-Arn, enquanto lambda-stack exporta Lambda-Arn
    // e importa BucketArn — o deploy falharia. Detectar aqui dá ao loop da IA
    // o contexto correto para colocar os constructs interdependentes na mesma stack.
    if (provider === 'aws' || provider === 'azure') {
      try {
        orderByDependency(listTemplates(cwd, provider));
      } catch (err) {
        this.error((err as Error).message);
      }
    }

    // ── Validação via CLI do provider (após synth) ────────────────────────────
    if (provider === 'aws') {
      this.validateAwsTemplates(cwd, flags.stack);
    } else if (provider === 'azure') {
      this.validateAzureTemplates(cwd, config.resourceGroup, flags.stack);
    }
  }

  /**
   * Valida templates CloudFormation gerados com `aws cloudformation validate-template`.
   * Requer aws CLI configurado e credenciais ativas. Skipa silenciosamente se
   * a ferramenta não estiver disponível.
   */
  private validateAwsTemplates(cwd: string, stack?: string): void {
    const awsCheck = spawnSync('aws', ['--version'], { encoding: 'utf-8' });
    if (awsCheck.error) {
      this.log('  aws CLI não encontrado — aws cloudformation validate-template skipped.');
      return;
    }

    const dir = providerOutDir(cwd, 'aws');
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(
      f => f.endsWith('.json') && !f.startsWith('_') && (!stack || f === `${stack}.json`),
    );

    let hasError = false;
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stackName = file.replace('.json', '');
      const result = spawnSync(
        'aws',
        ['cloudformation', 'validate-template', '--template-body', `file://${filePath}`],
        { encoding: 'utf-8' },
      );
      if (result.status !== 0) {
        this.warn(`aws cloudformation validate-template falhou para '${stackName}':\n${result.stderr || result.stdout}`);
        hasError = true;
      } else {
        this.log(`  CFN validate OK: ${stackName}`);
      }
    }

    if (hasError) {
      this.error('Validação CloudFormation encontrou erros. Corrija antes de fazer deploy.');
    }
  }

  /**
   * Valida templates Bicep gerados em dois estágios:
   *   1. `az bicep build --stdout` — sintaxe/compilação (sem resource group)
   *   2. `az deployment group validate` — validação via API Azure (requer RG ativo)
   * Skipa graciosamente se az CLI não estiver disponível.
   */
  private validateAzureTemplates(cwd: string, resourceGroup?: string, stack?: string): void {
    const azCheck = spawnSync('az', ['--version'], { encoding: 'utf-8' });
    if (azCheck.error) {
      this.log('  az CLI não encontrado — validação Azure skipped.');
      return;
    }

    const dir = providerOutDir(cwd, 'azure');
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(
      f => f.endsWith('.bicep') && !f.startsWith('_') && (!stack || f === `${stack}.bicep`),
    );
    if (files.length === 0) return;

    // Estágio 1: compilação Bicep (detecta erros de sintaxe sem precisar de RG)
    let hasError = false;
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stackName = file.replace('.bicep', '');
      const result = spawnSync('az', ['bicep', 'build', '--file', filePath, '--stdout'], { encoding: 'utf-8' });
      if (result.status !== 0) {
        this.warn(`az bicep build falhou para '${stackName}':\n${result.stderr || result.stdout}`);
        hasError = true;
      } else {
        this.log(`  Bicep build OK: ${stackName}`);
      }
    }
    if (hasError) {
      this.error('Erro de sintaxe Bicep. Corrija antes de fazer deploy.');
    }

    // Estágio 2: validação via API Azure (requer resource group configurado e existente)
    if (!resourceGroup) {
      this.log('  az deployment validate: resourceGroup não configurado no iacmp.json — skipped.');
      return;
    }
    const rgCheck = spawnSync(
      'az',
      ['group', 'show', '--name', resourceGroup, '--query', 'name', '-o', 'tsv'],
      { encoding: 'utf-8' },
    );
    if (rgCheck.status !== 0) {
      this.log(`  az deployment validate: resource group "${resourceGroup}" não existe — skipped.`);
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stackName = file.replace('.bicep', '');
      const params = this.detectBicepRequiredParams(filePath);
      const paramArgs = Object.entries(params).flatMap(([k, v]) => ['--parameters', `${k}=${v}`]);
      const result = spawnSync(
        'az',
        [
          'deployment', 'group', 'validate',
          '--resource-group', resourceGroup,
          '--template-file', filePath,
          '--mode', 'Incremental',
          ...paramArgs,
        ],
        { encoding: 'utf-8' },
      );
      if (result.status !== 0) {
        const output = result.stderr || result.stdout || '';
        // MaxNumberOfRegionalEnvironmentsInSubExceeded: o sharedCaeId param resolve
        // em deploy-time — não é um erro real de template, apenas uma limitação de
        // quota que o deploy orquestra via outputs acumulados entre stacks.
        if (output.includes('MaxNumberOfRegionalEnvironmentsInSubExceeded')) {
          this.log(`  az deployment validate: ${stackName} — CAE quota (sharedCaeId resolve em deploy)`);
        } else {
          this.warn(`az deployment group validate falhou para '${stackName}':\n${output}`);
          hasError = true;
        }
      } else {
        this.log(`  az deployment validate OK: ${stackName}`);
      }
    }

    if (hasError) {
      this.error('Validação Azure encontrou erros. Corrija antes de fazer deploy.');
    }
  }

  /**
   * Detecta params Bicep sem valor default (obrigatórios) e retorna um mapa
   * `nome → valor dummy` tipado, para passar ao `az deployment group validate`
   * sem travar por "missing required parameter".
   */
  private detectBicepRequiredParams(filePath: string): Record<string, string> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const params: Record<string, string> = {};
    for (const line of content.split('\n')) {
      // Param obrigatório: `param <nome> <tipo>` sem `= <default>` ao final
      const m = line.match(/^param\s+(\w+)\s+(\w+)\s*$/);
      if (!m) continue;
      const [, name, type] = m;
      switch (type) {
        case 'int':  params[name] = '0'; break;
        case 'bool': params[name] = 'false'; break;
        default:     params[name] = 'dummy'; break;
      }
    }
    return params;
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

  /**
   * Bloqueia handler de Lambda-em-VPC que acessa Secrets Manager em runtime.
   * Cruza cada Fn.Lambda com vpcId ao seu arquivo de handler (src/<stem>.ts) e
   * detecta uso de SecretsManager/getSecretValue/@aws-sdk/client-secrets-manager.
   * No iacmp (sem NAT gerado), isso trava a função — a senha do banco já é
   * injetada resolvida na env DB_PASSWORD (via {{resolve:secretsmanager}}).
   */
  private validateHandlerVpcSecrets(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const SECRET_USE = /SecretsManager|getSecretValue|@aws-sdk\/client-secrets-manager|from ['"]aws-sdk['"]/;

    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Function.Lambda') continue;
        const props = c.props as Record<string, unknown>;
        if (!props.vpcId) continue; // só Lambda em VPC
        const handler = props.handler as string | undefined;
        if (!handler) continue;
        const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
        const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
          .find(p => fs.existsSync(p));
        if (!srcFile) continue;
        const content = fs.readFileSync(srcFile, 'utf-8');
        if (SECRET_USE.test(content)) {
          errors.push(
            `Fn.Lambda "${c.id}" (em VPC) → ${path.relative(cwd, srcFile)} usa Secrets Manager em runtime. ` +
            `A senha já vem resolvida na env: use process.env.DB_PASSWORD direto (padrão iacmp), sem @aws-sdk/client-secrets-manager.`,
          );
        }
      }
    }
    return errors;
  }

  /**
   * Bloqueia handler que acessa DynamoDB como se fosse um banco SQL. A IA
   * recorrentemente gera `pg`/`mysql` + `SELECT/INSERT ... FROM <tabela>` para
   * um projeto cujo único datastore é Database.DynamoDB — DynamoDB não fala SQL,
   * então `pg.Client.connect()` num host de DynamoDB trava e a query falha em
   * runtime. Só dispara quando NÃO há nenhum Database.SQL/DocumentDB no projeto
   * (aí o driver SQL não faz sentido) e há ao menos um Database.DynamoDB.
   */
  private validateHandlerDynamoNoSql(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    let hasDynamo = false;
    let hasSql = false;
    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type === 'Database.DynamoDB') hasDynamo = true;
        if (c.type === 'Database.SQL' || c.type === 'Database.DocumentDB') hasSql = true;
      }
    }
    if (!hasDynamo || hasSql) return errors;

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

    const SQL_DRIVER = /from\s+['"](pg|mysql|mysql2|pg-promise|knex|sqlite3|better-sqlite3)['"]|require\(\s*['"](pg|mysql|mysql2|pg-promise|knex|sqlite3|better-sqlite3)['"]\s*\)/;
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (SQL_DRIVER.test(content)) {
        errors.push(
          `${path.relative(cwd, file)}: importa um driver SQL (pg/mysql/...) mas o projeto usa DynamoDB, que NÃO é SQL. ` +
          `Use o DocumentClient (@aws-sdk/lib-dynamodb: DynamoDBDocumentClient + GetCommand/PutCommand/QueryCommand/ScanCommand) — sem SELECT/INSERT nem pg.Client.`,
        );
      }
    }
    return errors;
  }

  /**
   * Bloqueia handler que consulta um GSI (`IndexName: 'X'`) que nenhuma
   * Database.DynamoDB do projeto declara em `globalSecondaryIndexes`. A IA gera
   * QueryCommand num índice (típico: 'TTLIndex' pra limpeza por TTL) sem provisionar
   * o GSI na tabela → deploya, mas a query estoura `ValidationException: The table
   * does not have the specified index` em runtime. Cruza os IndexName usados nos
   * handlers com os nomes de GSI declarados; nome inexistente → erro.
   */
  private validateHandlerDynamoGsi(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const declaredIndexes = new Set<string>();
    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Database.DynamoDB') continue;
        const gsis = ((c.props as Record<string, unknown>).globalSecondaryIndexes as Array<Record<string, unknown>>) ?? [];
        for (const g of gsis) if (typeof g.name === 'string') declaredIndexes.add(g.name);
      }
    }
    const hasDynamo = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.DynamoDB'));
    if (!hasDynamo) return errors;

    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) return errors;
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
    });
    for (const file of walk(srcDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      const used = new Set<string>();
      for (const m of content.matchAll(/IndexName\s*:\s*['"]([^'"]+)['"]/g)) used.add(m[1]);
      const missing = [...used].filter(name => !declaredIndexes.has(name)).sort();
      if (missing.length > 0) {
        errors.push(
          `${path.relative(cwd, file)}: consulta o(s) índice(s) ${missing.map(n => `'${n}'`).join(', ')} ` +
          `mas nenhuma Database.DynamoDB declara em globalSecondaryIndexes. ` +
          `Ou declare o GSI na tabela (globalSecondaryIndexes: [{ name, partitionKey, ... }]) e libere ` +
          `\`<TableArn>/index/*\` na Policy.IAM, ou — para limpeza por TTL — troque QueryCommand(IndexName) ` +
          `por ScanCommand + FilterExpression 'attr < :now' (sem índice).`,
        );
      }
    }
    return errors;
  }

  /**
   * Bloqueia Fn.Lambda que define DB_USER (ou PGUSER/DB_USERNAME) como STRING
   * literal quando há um Database.SQL no projeto. O admin real varia por cloud
   * (AWS RDS e Azure flexible = 'dbadmin'), então um valor cravado como 'postgres'
   * deploya mas quebra a autenticação em runtime. Só `ref('<Db>','Username')` (que
   * o synth carrega como objeto Ref, não string) resolve pro admin certo de cada
   * cloud. Detecta o valor literal e manda trocar pelo ref.
   */
  private validateDbUserRef(loaded: LoadedStack[]): string[] {
    const errors: string[] = [];
    const hasSql = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.SQL'));
    if (!hasSql) return errors;
    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Function.Lambda') continue;
        const env = (c.props as Record<string, unknown>).environment as Record<string, unknown> | undefined;
        if (!env) continue;
        // ref() é carregado como objeto (isRef); só string literal é hardcode.
        for (const key of ['DB_USER', 'PGUSER', 'DB_USERNAME']) {
          const v = env[key];
          if (typeof v === 'string') {
            errors.push(
              `Fn.Lambda "${c.id}": ${key} está hardcoded como '${v}'. Use ref('<DbId>','Username') — ` +
              `o admin do Database.SQL varia por cloud (AWS/Azure = 'dbadmin'); um valor cravado quebra a auth em runtime.`,
            );
          }
        }
      }
    }
    return errors;
  }

  /**
   * Bloqueia handler que usa um nome de atributo RESERVADO do DynamoDB cru numa
   * expressão (FilterExpression/KeyConditionExpression/ConditionExpression/
   * ProjectionExpression) sem aliasar com `#`. Ex: `FilterExpression: 'ttl < :now'`
   * — `ttl` é palavra reservada → `ValidationException: Attribute name is a
   * reserved keyword` em runtime. Só considera palavras reservadas de alta
   * confiança que colidem com nomes de atributo comuns; ignora `#alias`,
   * `:placeholder` e chamadas de função (`attribute_exists(...)`, `size(...)`).
   */
  private validateHandlerDynamoReservedWords(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const hasDynamo = loaded.some(({ stack }) => stack.constructs.some(c => c.type === 'Database.DynamoDB'));
    if (!hasDynamo) return errors;
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) return errors;
    // Subconjunto (alta confiança) dos reserved words do DynamoDB que colidem com
    // nomes de atributo comuns em apps. Todos exigem `#alias` numa expressão.
    const RESERVED = new Set([
      'ttl', 'name', 'status', 'date', 'timestamp', 'type', 'data', 'value', 'count', 'size',
      'order', 'user', 'source', 'region', 'hash', 'range', 'year', 'month', 'day', 'hour',
      'minute', 'second', 'state', 'group', 'role', 'action', 'time', 'token', 'level', 'owner',
      'comment', 'connection', 'filter', 'language', 'location', 'password', 'position', 'percent',
      'view', 'zone', 'target', 'tag', 'duration', 'period', 'capacity', 'bytes', 'timezone', 'key',
    ]);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
    });
    const EXPR = /(?:FilterExpression|KeyConditionExpression|ConditionExpression|ProjectionExpression)\s*:\s*(['"`])([^'"`]*)\1/g;
    // palavra não precedida de # (alias) nem : (placeholder), com o char seguinte capturado p/ excluir função `word(`
    const WORD = /(^|[^A-Za-z0-9_#:])([A-Za-z_][A-Za-z0-9_]*)\s*(\(?)/g;
    for (const file of walk(srcDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      const flagged = new Set<string>();
      for (const m of content.matchAll(EXPR)) {
        for (const t of m[2].matchAll(WORD)) {
          if (t[3] === '(') continue; // chamada de função (attribute_exists, begins_with, size...)
          const word = t[2].toLowerCase();
          if (RESERVED.has(word)) flagged.add(t[2]);
        }
      }
      if (flagged.size > 0) {
        const list = [...flagged].sort();
        errors.push(
          `${path.relative(cwd, file)}: a(s) expressão(ões) DynamoDB usam nome(s) reservado(s) ${list.map(w => `'${w}'`).join(', ')} sem alias. ` +
          `Aliase com ExpressionAttributeNames (${list.map(w => `{ '#${w.toLowerCase()}': '${w}' }`).join(', ')}) e use '#${list[0].toLowerCase()}' na expressão — ` +
          `nome reservado cru estoura ValidationException: Attribute name is a reserved keyword em runtime.`,
        );
      }
    }
    return errors;
  }

  /**
   * Bloqueia handler que usa o driver `pg` sem `ssl` quando o projeto tem um
   * Database.SQL postgres. RDS PostgreSQL moderno recusa conexão sem TLS —
   * o erro só aparece em runtime ("no pg_hba.conf entry ... no encryption").
   * Heurística: importa 'pg' e o fonte não contém `ssl:`.
   */
  private validateHandlerPgSsl(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const hasPostgres = loaded.some(({ stack }) =>
      stack.constructs.some(c => c.type === 'Database.SQL' && ((c.props as Record<string, unknown>).engine ?? 'postgres') === 'postgres'));
    if (!hasPostgres) return errors;
    const srcDir = path.join(cwd, 'src');
    if (!fs.existsSync(srcDir)) return errors;
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.ts') || e.name.endsWith('.js')) ? [full] : [];
    });
    for (const file of walk(srcDir)) {
      const content = fs.readFileSync(file, 'utf-8');
      const usesPg = /from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)/.test(content);
      if (usesPg && !/\bssl\s*:/.test(content)) {
        errors.push(
          `${path.relative(cwd, file)}: usa o driver pg sem \`ssl\` na config do Client. ` +
          `Adicione \`ssl: { rejectUnauthorized: false }\` — RDS PostgreSQL exige conexão encriptada.`,
        );
      }
    }
    return errors;
  }

  /**
   * Bloqueia Fn.Lambda cujo handler lê `process.env.X` sem que o construct
   * declare a chave em `environment`. Padrão recorrente da geração: o handler
   * usa TABLE_NAME/QUEUE_URL e o construct sai sem environment — deploya, mas
   * TODO request falha em runtime (ex: ValidationException: tableName null).
   * Ignora envs injetadas pelo runtime (AWS_*, _HANDLER etc) e NODE_ENV.
   */
  private validateHandlerEnvVars(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const RUNTIME_PROVIDED = /^(AWS_|_|LAMBDA_|NODE_ENV$|TZ$)/;
    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Function.Lambda') continue;
        const props = c.props as Record<string, unknown>;
        const handler = props.handler as string | undefined;
        if (!handler) continue;
        const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
        const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
          .find(p => fs.existsSync(p));
        if (!srcFile) continue;
        const content = fs.readFileSync(srcFile, 'utf-8');
        const used = new Set<string>();
        for (const m of content.matchAll(/process\.env[.[]['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\]?/g)) {
          if (!RUNTIME_PROVIDED.test(m[1])) used.add(m[1]);
        }
        if (used.size === 0) continue;
        const declared = new Set(Object.keys((props.environment as Record<string, unknown>) ?? {}));
        const missing = [...used].filter(k => !declared.has(k)).sort();
        if (missing.length > 0) {
          errors.push(
            `Fn.Lambda "${c.id}" → ${path.relative(cwd, srcFile)} lê process.env.${missing.join('/')} ` +
            `mas o construct não declara essa(s) chave(s). Adicione environment: { ${missing.map(k => `${k}: <valor ou ref(...)>`).join(', ')} } no Fn.Lambda.`,
          );
        }
      }
    }
    return errors;
  }

  /**
   * Bloqueia Lambda-em-VPC (subnet privada) que acessa DynamoDB/S3 sem um
   * Gateway VPC Endpoint do serviço. Sem NAT nem endpoint, a subnet privada não
   * alcança serviços da AWS fora da VPC — o SDK pendura e a Lambda dá timeout.
   * Gateway Endpoints (dynamodb/s3) são grátis e resolvem isso. Cruza cada
   * Fn.Lambda com vpcId ao seu handler; se usa o SDK do serviço, exige um
   * Network.VpcEndpoint com aquele serviço em alguma das stacks carregadas.
   */
  private validateLambdaVpcGatewayEndpoint(loaded: LoadedStack[], cwd: string): string[] {
    const errors: string[] = [];
    const endpointServices = new Set<string>();
    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Network.VpcEndpoint') continue;
        for (const s of ((c.props as Record<string, unknown>).services as string[]) ?? []) {
          endpointServices.add(s);
        }
      }
    }

    const SDK_BY_SERVICE: Array<{ service: string; re: RegExp }> = [
      { service: 'dynamodb', re: /@aws-sdk\/(client|lib)-dynamodb/ },
      { service: 's3', re: /@aws-sdk\/client-s3/ },
    ];

    for (const { stack } of loaded) {
      for (const c of stack.constructs) {
        if (c.type !== 'Function.Lambda') continue;
        const props = c.props as Record<string, unknown>;
        if (!props.vpcId) continue; // só Lambda em VPC
        const handler = props.handler as string | undefined;
        if (!handler) continue;
        const stem = handler.replace(/\.[^./]+$/, '').replace(/^(\.\/)?(dist|src)\//, '');
        const srcFile = [path.join(cwd, 'src', `${stem}.ts`), path.join(cwd, 'src', `${stem}.js`)]
          .find(p => fs.existsSync(p));
        if (!srcFile) continue;
        const content = fs.readFileSync(srcFile, 'utf-8');
        for (const { service, re } of SDK_BY_SERVICE) {
          if (re.test(content) && !endpointServices.has(service)) {
            errors.push(
              `Fn.Lambda "${c.id}" (em VPC) → ${path.relative(cwd, srcFile)} acessa ${service.toUpperCase()}, ` +
              `mas não há Gateway VPC Endpoint para '${service}'. Sem NAT, a Lambda em subnet privada não alcança o serviço e dá timeout. ` +
              `Adicione um Network.VpcEndpoint com services: ['${service}'] e os subnetIds das subnets privadas, na mesma stack da VPC.`,
            );
          }
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
