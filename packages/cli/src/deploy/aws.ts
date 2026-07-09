import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from './types';

function packagedTemplatePath(ctx: DeployContext): string {
  return path.join(path.dirname(ctx.templatePath), '.packaged', `${ctx.stackName}.json`);
}

/**
 * `aws cloudformation package` resolve o `Code` (string) de cada
 * `AWS::Lambda::Function` relativo ao DIRETÓRIO DO TEMPLATE
 * (`synth-out/aws/`), não à raiz do projeto — mas o usuário escreve
 * `code: 'dist/'` no construct pensando na raiz do projeto (onde `dist/`
 * normalmente vive, ao lado de `stacks/`). Sem isso, `package` procura
 * `synth-out/aws/dist/` e falha mesmo quando o `dist/` real existe.
 *
 * Reescreve esses caminhos para absoluto (relativo a `ctx.cwd`) num template
 * intermediário antes de empacotar — caminho absoluto não tem ambiguidade de
 * resolução. Se nenhum `Code` precisar de ajuste, reusa o template original.
 */
function resolveLambdaCodePaths(ctx: DeployContext): string {
  const raw = fs.readFileSync(ctx.templatePath, 'utf-8');
  const template = JSON.parse(raw) as { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };
  let changed = false;

  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const code = resource.Properties?.Code;
    if (typeof code === 'string' && !path.isAbsolute(code)) {
      resource.Properties!.Code = path.resolve(ctx.cwd, code);
      changed = true;
    }
  }

  if (!changed) return ctx.templatePath;

  const resolvedPath = path.join(path.dirname(ctx.templatePath), '.packaged', `${ctx.stackName}.input.json`);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(template, null, 2));
  return resolvedPath;
}

/**
 * Compila E EMPACOTA (bundle) os handlers TypeScript antes do
 * `cloudformation package`. O synth aponta o `Code` da Lambda para o diretório
 * de saída (ex: `dist/`), mas o deploy não roda build — e, mesmo compilando com
 * `tsc`, o pacote conteria só o JS do handler SEM as dependências de terceiros
 * (ex: `ioredis`), fazendo a Lambda falhar em runtime com `Cannot find module`.
 * Usamos esbuild para gerar um bundle self-contained (deps inlinadas), marcando
 * `@aws-sdk/*` como external (o runtime Node da Lambda já provê o SDK v3).
 */
export function ensureLambdaCodeBuilt(ctx: DeployContext): void {
  if (ctx.dryRun || !ctx.templatePath) return; // dry-run não executa efeitos locais
  const raw = fs.readFileSync(ctx.templatePath, 'utf-8');
  const template = JSON.parse(raw) as { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };

  // Coleta (arquivo de saída .js → fonte .ts/.js do handler) por Lambda.
  const jobs = new Map<string, string>();
  for (const resource of Object.values(template.Resources ?? {})) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const code = resource.Properties?.Code;
    const handler = resource.Properties?.Handler;
    if (typeof code !== 'string' || typeof handler !== 'string') continue;

    const handlerModule = handler.replace(/\.[^./]+$/, ''); // tira o .export final
    const stem = handlerModule.replace(/^(\.\/)?(dist|src)\//, '');
    const entry = [
      path.join(ctx.cwd, 'src', `${stem}.ts`),
      path.join(ctx.cwd, 'src', `${stem}.js`),
    ].find(p => fs.existsSync(p));
    if (!entry) continue; // sem fonte — nada a bundlar (handler pré-compilado à parte)

    const outfile = path.resolve(ctx.cwd, code, `${handlerModule}.js`);
    jobs.set(outfile, entry);
  }
  if (jobs.size === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let esbuild: { buildSync: (opts: Record<string, unknown>) => unknown };
  try {
    esbuild = require('esbuild');
  } catch {
    throw new Error('esbuild não encontrado — não foi possível empacotar os handlers da Lambda. Rode `npm install` no iacmp.');
  }

  for (const [outfile, entry] of jobs) {
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    try {
      esbuild.buildSync({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        external: ['@aws-sdk/*'], // provido pelo runtime da Lambda
        logLevel: 'silent',
      });
    } catch (err) {
      throw new Error(`Falha ao empacotar o handler ${path.relative(ctx.cwd, entry)} com esbuild:\n${(err as Error).message}`);
    }
  }
}

/**
 * `aws cloudformation package`/`deploy` não têm um equivalente ao
 * `--resolve-s3` do SAM CLI — exigem `--s3-bucket` explícito sempre. Resolve
 * um nome determinístico (por conta+região) para não precisar pedir esse
 * bucket no iacmp.json.
 */
export function getAccountId(): string {
  try {
    return execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    throw new Error(
      'Não foi possível obter a conta AWS (aws sts get-caller-identity). Configure as credenciais com: aws configure'
    );
  }
}

export function artifactBucketName(accountId: string, region: string): string {
  return `iacmp-deploy-artifacts-${accountId}-${region}`;
}

export function bucketExists(bucket: string): boolean {
  try {
    execFileSync('aws', ['s3api', 'head-bucket', '--bucket', bucket], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resource types que o iacmp gera com DeletionPolicy Retain/Snapshot E um
 * identificador físico determinístico (não auto-gerado pelo CloudFormation)
 * — únicos capazes de sobreviver à destruição de uma stack e colidir num
 * deploy seguinte. Mapeia o Type do CloudFormation pro nome da Property que
 * carrega esse identificador. Resources sem essa propriedade (Type ausente
 * deste mapa) nunca colidem por nome — CloudFormation gera um físico único a
 * cada criação.
 */
const RETAINABLE_RESOURCE_IDENTIFIER_PROPERTY: Record<string, string> = {
  'AWS::DynamoDB::Table': 'TableName',
  'AWS::DocDB::DBCluster': 'DBClusterIdentifier',
};

export interface ExistingResource {
  logicalId: string;
  typeName: string;
  identifier: string;
}

/**
 * Checagem de existência via AWS Cloud Control API — uma única chamada
 * genérica (`get-resource`) que funciona pra qualquer Type do CloudFormation,
 * em vez de um comando de "describe" próprio por serviço (dynamodb
 * describe-table, s3api head-bucket, iam get-role, ...).
 */
export function resourceExists(typeName: string, identifier: string, region: string): boolean {
  try {
    execFileSync('aws', ['cloudcontrol', 'get-resource', '--type-name', typeName, '--identifier', identifier, '--region', region], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apaga um recurso via Cloud Control API (genérico, qualquer Type) e espera
 * a operação terminar — `delete-resource` é assíncrono, só devolve um
 * RequestToken; sem aguardar, o `cloudformation deploy` seguinte tentaria
 * recriar o recurso antes da exclusão real ter terminado na AWS.
 */
export async function deleteResourceAndWait(typeName: string, identifier: string, region: string): Promise<void> {
  const start = JSON.parse(
    execFileSync('aws', ['cloudcontrol', 'delete-resource', '--type-name', typeName, '--identifier', identifier, '--region', region], { stdio: 'pipe' }).toString()
  ) as { ProgressEvent: { RequestToken: string } };

  let status = 'IN_PROGRESS';
  while (status === 'IN_PROGRESS' || status === 'PENDING') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const poll = JSON.parse(
      execFileSync('aws', ['cloudcontrol', 'get-resource-request-status', '--request-token', start.ProgressEvent.RequestToken, '--region', region], { stdio: 'pipe' }).toString()
    ) as { ProgressEvent: { OperationStatus: string; StatusMessage?: string } };
    status = poll.ProgressEvent.OperationStatus;
    if (status === 'FAILED') {
      throw new Error(`Falha ao apagar ${typeName} "${identifier}": ${poll.ProgressEvent.StatusMessage ?? 'motivo desconhecido'}`);
    }
  }
}

/**
 * Antes de criar uma stack, verifica se algum recurso que o CloudFormation
 * normalmente RETÉM (DeletionPolicy Retain/Snapshot) ao destruir a stack já
 * existe na conta — sinal de que uma stack anterior foi destruída mas deixou
 * esse recurso vivo e órfão. Sem isso, `aws cloudformation deploy` só
 * descobre o conflito depois de tentar criar o changeset, com um erro
 * confuso (ResourceExistenceCheck).
 *
 * Exclui recursos já pertencentes à própria stack (drift benigno ou redeploy
 * sem mudanças de template) para evitar deletar e recriar desnecessariamente.
 */
export function findExistingRetainedResources(templatePath: string, region: string, stackName?: string): ExistingResource[] {
  const raw = fs.readFileSync(templatePath, 'utf-8');
  const template = JSON.parse(raw) as { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };

  const candidates: ExistingResource[] = [];
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    const identifierProp = resource.Type ? RETAINABLE_RESOURCE_IDENTIFIER_PROPERTY[resource.Type] : undefined;
    if (!identifierProp) continue;
    const identifier = resource.Properties?.[identifierProp];
    if (typeof identifier !== 'string') continue;
    candidates.push({ logicalId, typeName: resource.Type as string, identifier });
  }

  const existing = candidates.filter((c) => resourceExists(c.typeName, c.identifier, region));
  if (!stackName || existing.length === 0) return existing;

  // Filtra recursos já pertencentes à própria stack — não são órfãos
  const ownedByStack = new Set<string>();
  try {
    const out = execFileSync('aws', [
      'cloudformation', 'list-stack-resources',
      '--stack-name', stackName, '--region', region,
      '--query', 'StackResourceSummaries[].[LogicalResourceId,PhysicalResourceId]',
      '--output', 'json',
    ], { stdio: 'pipe' }).toString();
    const rows = JSON.parse(out) as [string, string][];
    for (const [, physicalId] of rows) ownedByStack.add(physicalId);
  } catch (err) {
    // Stack não existe ainda (esperado na primeira criação) ou erro transiente da AWS.
    // Neste caso, tratamos todos os recursos como candidatos a conflito.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('does not exist') && !msg.includes('Stack with id')) {
      process.stderr.write(`[iacmp] aviso: não foi possível listar recursos da stack "${stackName}": ${msg}\n`);
    }
  }

  return existing.filter((c) => !ownedByStack.has(c.identifier));
}

export const awsExecutor: DeployExecutor = {
  provider: 'aws',
  requiredBinary: 'aws',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const packaged = packagedTemplatePath(ctx);
    // `aws cloudformation package` não cria o diretório de destino — garante
    // que existe antes (operação local, sem efeito na nuvem, segura em --dry-run).
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    // Compila os handlers TS (dist/) antes de empacotar — o synth referencia a
    // saída do build, que o deploy precisa gerar.
    ensureLambdaCodeBuilt(ctx);
    const inputTemplate = resolveLambdaCodePaths(ctx);

    const accountId = getAccountId();
    const bucket = artifactBucketName(accountId, ctx.region);
    const commands: NativeCommand[] = [];

    const existingStatus = describeStackStatus(ctx.stackName, ctx.region);
    const rollbackStates = ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED'];
    if (existingStatus.deployed && existingStatus.status && rollbackStates.includes(existingStatus.status)) {
      // Limpa sincrono aqui — mais confiável do que colocar no array de comandos,
      // porque entre o planDeploy e a execução dos comandos o estado pode mudar.
      let statusNow = existingStatus.status;
      if (statusNow === 'ROLLBACK_IN_PROGRESS') {
        try {
          execFileSync('aws', ['cloudformation', 'wait', 'stack-rollback-complete', '--stack-name', ctx.stackName, '--region', ctx.region], { stdio: 'pipe' });
        } catch { /* stack pode ter sido deletada por outro processo — seguir */ }
        statusNow = describeStackStatus(ctx.stackName, ctx.region).status ?? '';
      }
      if (['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'UPDATE_ROLLBACK_FAILED'].includes(statusNow)) {
        try {
          execFileSync('aws', ['cloudformation', 'delete-stack', '--stack-name', ctx.stackName, '--region', ctx.region], { stdio: 'pipe' });
          execFileSync('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', ctx.stackName, '--region', ctx.region], { stdio: 'pipe' });
        } catch { /* stack já deletada — ok */ }
      }
    }

    if (!bucketExists(bucket)) {
      commands.push({ bin: 'aws', args: ['s3', 'mb', `s3://${bucket}`, '--region', ctx.region] });
    }

    commands.push({
      bin: 'aws',
      args: [
        'cloudformation', 'package',
        '--template-file', inputTemplate,
        '--s3-bucket', bucket,
        '--output-template-file', packaged,
        '--region', ctx.region,
      ],
    });
    commands.push({
      bin: 'aws',
      args: [
        'cloudformation', 'deploy',
        '--template-file', packaged,
        '--stack-name', ctx.stackName,
        '--capabilities', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND',
        '--region', ctx.region,
        '--no-fail-on-empty-changeset',
      ],
    });
    return commands;
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    return [
      { bin: 'aws', args: ['cloudformation', 'delete-stack', '--stack-name', ctx.stackName, '--region', ctx.region] },
      { bin: 'aws', args: ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', ctx.stackName, '--region', ctx.region] },
    ];
  },

  describeStatus(stackName: string, ctx: { region: string }): StackStatus {
    return describeStackStatus(stackName, ctx.region);
  },

  async pollStatus(stackName: string, ctx: { region: string }): Promise<string | null> {
    try {
      const out = execFileSync('aws', [
        'cloudformation', 'describe-stacks',
        '--stack-name', stackName,
        '--region', ctx.region,
        '--query', 'Stacks[0].[StackStatus,StackStatusReason]',
        '--output', 'json',
      ], { stdio: 'pipe' }).toString();
      const result = JSON.parse(out) as [string, string | null];
      const [status, reason] = result;
      if (!status) return null;
      return reason ? `${status} → ${reason}` : status;
    } catch {
      return null;
    }
  },
};

export function describeStackStatus(stackName: string, region: string): StackStatus {
  try {
    const status = execFileSync(
      'aws',
      ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region, '--query', 'Stacks[0].StackStatus', '--output', 'text'],
      { stdio: 'pipe' }
    ).toString().trim();
    return { deployed: true, status };
  } catch {
    return { deployed: false };
  }
}
