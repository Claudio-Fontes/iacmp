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
import {
  LoadedStack,
  validateHandlerFiles,
  validateHandlerSql,
  validateHandlerVpcSecrets,
  validateHandlerDynamoNoSql,
  validateLambdaVpcGatewayEndpoint,
  validateHandlerPgSsl,
  validateHandlerEnvVars,
  validateHandlerDynamoGsi,
  validateHandlerDynamoReservedWords,
  validateDbUserRef,
  validateRedisPortRef,
} from '../validators';

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
    const handlerErrors = validateHandlerFiles(loadedStacks, cwd);
    if (handlerErrors.length > 0) {
      this.error(
        `Handler(s) de Lambda sem arquivo de origem correspondente:\n\n` +
        handlerErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Validação de SQL nos handlers (src/) ────────────────────────────────
    // Pega INSERT com contagem de colunas != valores — bug recorrente da IA que
    // só apareceria em runtime ("INSERT has more target columns than expressions").
    const sqlErrors = validateHandlerSql(cwd);
    if (sqlErrors.length > 0) {
      this.error(
        `SQL inválido em handler(s):\n\n` + sqlErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler de Lambda-em-VPC usando Secrets Manager em runtime ──────────
    // Lambda em subnet privada não alcança o Secrets Manager (serviço fora da
    // VPC) sem NAT/VPC endpoint — o SDK pendura e a função dá timeout de 30s
    // (Service Unavailable). A senha do banco já vem resolvida na env DB_PASSWORD.
    const vpcSecretErrors = validateHandlerVpcSecrets(loadedStacks, cwd);
    if (vpcSecretErrors.length > 0) {
      this.error(
        `Handler de Lambda em VPC acessa Secrets Manager em runtime (vai dar timeout no deploy):\n\n` +
        vpcSecretErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler acessando DynamoDB como SQL ─────────────────────────────────
    // A IA às vezes gera pg/mysql + SELECT/INSERT para um projeto que só tem
    // DynamoDB. DynamoDB não é SQL — trava em runtime. Bloqueia em synth-time.
    const dynamoSqlErrors = validateHandlerDynamoNoSql(loadedStacks, cwd);
    if (dynamoSqlErrors.length > 0) {
      this.error(
        `Handler acessa DynamoDB como banco SQL (vai falhar em runtime):\n\n` +
        dynamoSqlErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Lambda-em-VPC acessando DynamoDB/S3 sem Gateway VPC Endpoint ─────────
    // Subnet privada sem NAT não alcança serviços da AWS fora da VPC; o SDK
    // pendura e a Lambda dá timeout. Gateway Endpoint (grátis) resolve.
    const gatewayEndpointErrors = validateLambdaVpcGatewayEndpoint(loadedStacks, cwd);
    if (gatewayEndpointErrors.length > 0) {
      this.error(
        `Lambda em VPC acessa serviço AWS sem Gateway VPC Endpoint (vai dar timeout no deploy):\n\n` +
        gatewayEndpointErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Handler pg sem ssl contra RDS PostgreSQL ─────────────────────────────
    // RDS Postgres 14+ exige conexão encriptada (pg_hba: "no encryption").
    // Handler com pg.Client sem `ssl:` falha TODO request em runtime.
    const pgSslErrors = validateHandlerPgSsl(loadedStacks, cwd);
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
    const envVarErrors = validateHandlerEnvVars(loadedStacks, cwd);
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
    const gsiErrors = validateHandlerDynamoGsi(loadedStacks, cwd);
    if (gsiErrors.length > 0) {
      this.error(
        `Handler consulta um GSI que a tabela DynamoDB não declara (ValidationException em runtime):\n\n` +
        gsiErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── Validação nomes reservados DynamoDB em expressões (sem alias '#') ────
    // FilterExpression: 'ttl < :now' → 'ttl' é reserved keyword → ValidationException
    // em runtime. Forçar o alias '#ttl' aqui dá o gatilho pro loop se auto-corrigir.
    const reservedErrors = validateHandlerDynamoReservedWords(loadedStacks, cwd);
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
    const dbUserErrors = validateDbUserRef(loadedStacks);
    if (dbUserErrors.length > 0) {
      this.error(
        `DB_USER hardcoded no Fn.Lambda (a auth do banco falha em runtime):\n\n` +
        dbUserErrors.map(e => `  • ${e}`).join('\n'),
      );
    }

    // ── REDIS_PORT hardcoded como '6379' quando existe Cache.Redis ────────────
    // Redis Enterprise (Azure) usa TLS na porta 10000 — não existe porta 6379.
    // '6379' hardcoded → conexão recusada em runtime. Forçar ref('Id','Port').
    const redisPortErrors = validateRedisPortRef(loadedStacks);
    if (redisPortErrors.length > 0) {
      this.error(
        `REDIS_PORT hardcoded no Fn.Lambda (Redis Enterprise usa TLS:10000 — '6379' não existe):\n\n` +
        redisPortErrors.map(e => `  • ${e}`).join('\n'),
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
      const rg = config.resourceGroup ?? (config.name ? `${config.name}-rg` : undefined);
      this.validateAzureTemplates(cwd, rg, flags.stack);
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
        } else if (output.includes('Alerts are currently not supported at') && output.includes('microsoft.app/containerapps')) {
          // Metric alerts para Container Apps só aceitam escopo de recurso individual.
          // O bicep.ts gera param alarmScopeId (default '') com condition — o alarm
          // só é criado quando o deploy injeta o resource ID real do Container App.
          this.log(`  az deployment validate: ${stackName} — Container Apps alert scope resolve em deploy (param alarmScopeId)`);
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
