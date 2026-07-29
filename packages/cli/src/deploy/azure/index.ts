import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from '../../i18n';
import { DeployContext, DeployExecutor, DestroyContext, NativeCommand, StackStatus } from '../types';
import {
  getAzureStackOutputs,
  requireResourceGroup,
  describeStackStatus,
  waitForStackTerminal,
  recoverFromAzCliCrash,
} from './stack-api';
import { getRunAdminPassword, getCrossStackParams, getSoftCrossStackParams, getStaticWebsiteOutputKeys, isSecretParam } from './params';
import { ensureBootstrapAcr, readBootstrapState, acrBootstrapName, getSubscriptionId } from './bootstrap-acr';
import { buildAndPushContainerImage, AzureContainerBuildMeta } from './container-build';
import { buildFunctionBundle, AzureFunctionMeta } from './function-bundle';

// API pública do módulo — consumida por deploy/index.ts, flows/ e testes.
export { getAzureStackOutputs, listApimServices, purgeApimSoftDeleted, resourceGroupExists, describeStackStatus } from './stack-api';

export const azureExecutor: DeployExecutor = {
  provider: 'azure',
  requiredBinary: 'az',

  async planDeploy(ctx: DeployContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [];

    const metaPath = ctx.templatePath.replace('.bicep', '.iacmp-meta.json');
    const zipCmds: NativeCommand[] = [];
    // Parâmetros produzidos pelo pipeline de build de imagem (acrServer/acrUser/acrPassword
    // + <imageParamName>=<imagem final> por Compute.Container com `build`) — injetados
    // ANTES do cálculo de `paramValues` abaixo para que entrem no `provided` set e não
    // sejam pisados pela lógica de soft/hard cross-stack params.
    const containerBuildParamValues: string[] = [];

    if (!ctx.dryRun && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
        functions: AzureFunctionMeta[];
        containerBuilds?: AzureContainerBuildMeta[];
      };
      const functions: AzureFunctionMeta[] = meta.functions ?? [];
      const containerBuilds: AzureContainerBuildMeta[] = meta.containerBuilds ?? [];

      if (containerBuilds.length > 0) {
        const acr = ensureBootstrapAcr(ctx.region);
        containerBuildParamValues.push(`acrServer=${acr.loginServer}`, `acrUser=${acr.username}`, `acrPassword=${acr.password}`);
        for (const build of containerBuilds) {
          const fullImage = buildAndPushContainerImage(build, ctx.cwd, acr);
          containerBuildParamValues.push(`${build.imageParamName}=${fullImage}`);
        }
      }

      for (const fn of functions) {
        process.stdout.write(t(
          `[iacmp] Empacotando ${fn.constructId} para Azure Functions...\n`,
          `[iacmp] Packaging ${fn.constructId} for Azure Functions...\n`,
        ));
        const zipPath = buildFunctionBundle(ctx.cwd, fn, ctx.templatePath);
        if (!zipPath) {
          process.stdout.write(t(
            `[iacmp] Handler não encontrado para ${fn.constructId} — zip ignorado.\n`,
            `[iacmp] Handler not found for ${fn.constructId} — zip skipped.\n`,
          ));
          continue;
        }
        const outputKey = fn.constructId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + 'functionappname';
        const lazyCmd: NativeCommand = { bin: 'az', args: [] };
        lazyCmd.preRun = () => {
          const outputs = getAzureStackOutputs(ctx.stackName, resourceGroup);
          const appName = outputs[outputKey] ?? outputs[Object.keys(outputs).find(k => k.toLowerCase() === outputKey) ?? ''];
          if (!appName) throw new Error(t(
            `Nome da Function App "${fn.constructId}" não encontrado nos outputs da stack "${ctx.stackName}".`,
            `Function App name for "${fn.constructId}" not found in the outputs of stack "${ctx.stackName}".`,
          ));
          process.stdout.write(t(
            `[iacmp] Publicando zip na Function App ${appName}...\n`,
            `[iacmp] Publishing zip to Function App ${appName}...\n`,
          ));
          lazyCmd.args = [
            'functionapp', 'deployment', 'source', 'config-zip',
            '--name', appName,
            '--resource-group', resourceGroup,
            '--src', zipPath,
          ];
        };
        lazyCmd.retries = 2;
        zipCmds.push(lazyCmd);
      }
    }

    // Usa "deployment stacks" (az stack group) em vez de `az deployment group
    // create` — dá um objeto rastreável que o destroy consegue remover por
    // completo (todos os recursos que ele criou), igual ao stack do CloudFormation.
    const args = [
      'stack', 'group', 'create',
      '--name', ctx.stackName,
      '--resource-group', resourceGroup,
      '--template-file', ctx.templatePath,
      '--deny-settings-mode', 'none',
      '--action-on-unmanage', 'deleteResources',
      '--yes',
    ];

    const paramValues: string[] = [...containerBuildParamValues];
    if (ctx.templatePath) {
      const crossParams = getCrossStackParams(ctx.templatePath);
      // adminPassword (@secure, sem default): o deploy gera UMA senha forte por
      // execução e injeta a MESMA em toda stack que declara o param — o servidor
      // Postgres/MySQL e as envs dos handlers (ref('AppDB','Password')) batem.
      if (crossParams.includes('adminPassword')) {
        paramValues.push(`adminPassword=${getRunAdminPassword()}`);
      }
      // Cross-params de senha (ex: AppDBPassword, vindos de ref('AppDB','Password')
      // em OUTRA stack): senha nunca é output (secure) — injeta a MESMA senha do
      // run, que é a que o servidor recebeu via adminPassword.
      for (const p of crossParams) {
        if (/password$/i.test(p) && p !== 'adminPassword') {
          paramValues.push(`${p}=${getRunAdminPassword()}`);
        }
      }
      const provided = new Set(paramValues.map(p => p.split('=')[0]));
      // A API do Azure devolve as chaves de outputs em camelCase mesmo quando o
      // Bicep declara PascalCase (`output ItemsTableName` → chave `itemsTableName`)
      // — o match do param com o output precisa ser case-insensitive.
      const outputsByLower = new Map(
        Object.entries(ctx.outputParams ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const missing: string[] = [];
      for (const p of crossParams) {
        if (provided.has(p)) continue;
        const value = outputsByLower.get(p.toLowerCase());
        if (value !== undefined) {
          paramValues.push(`${p}=${value}`);
        } else {
          missing.push(p);
        }
      }
      // Sem isso o `az` cai num prompt interativo pedindo o valor — pendura o
      // deploy em vez de falhar. Param cross-stack sem output correspondente
      // significa que a stack exportadora não foi deployada (ou falhou) antes.
      if (missing.length > 0) {
        throw new Error(t(
          `Stack "${ctx.stackName}" precisa de parâmetro(s) cross-stack sem valor: ${missing.join(', ')}. ` +
          `A stack que exporta esse(s) output(s) precisa ser deployada antes e com sucesso. ` +
          `Rode "iacmp deploy --provider azure" sem --stack para a ordem automática, ou verifique se a stack exportadora falhou.`,
          `Stack "${ctx.stackName}" needs cross-stack parameter(s) without a value: ${missing.join(', ')}. ` +
          `The stack exporting those output(s) must be deployed first and successfully. ` +
          `Run "iacmp deploy --provider azure" without --stack for automatic ordering, or check whether the exporting stack failed.`,
        ));
      }
      // Soft params (default ''): injetados quando disponíveis, sem erro se ausentes.
      // Usados pelo mecanismo de 2º passo para Event Grid subscriptions cross-stack —
      // 1º passo deploya sem o FQDN (subscrição não é criada por Bicep if-condition);
      // 2º passo re-deploya com FQDN disponível nos outputs acumulados.
      //
      // EXCEÇÃO sharedCaeId: não injetar se o valor em outputsByLower veio da PRÓPRIA
      // stack (output da 1ª passagem). Injetar o próprio sharedCaeId torna
      // empty(sharedCaeId)=false → CAE sai do template → ARM tenta deletar o env
      // → DeploymentStackDeleteResourcesFailed (CAE tem Container Apps attachados).
      // Para detectar auto-injeção: lê os outputs ATUAIS da stack e compara.
      let ownSharedCaeId: string | undefined;
      if (ctx.stackName && ctx.resourceGroup) {
        const ownOutputs = getAzureStackOutputs(ctx.stackName, ctx.resourceGroup);
        ownSharedCaeId = ownOutputs['sharedCaeId'];
      }
      const softParams = getSoftCrossStackParams(ctx.templatePath!);
      const providedAfterHard = new Set(paramValues.map(p => p.split('=')[0]));
      for (const p of softParams) {
        if (providedAfterHard.has(p)) continue;
        const value = outputsByLower.get(p.toLowerCase());
        if (!value) continue;
        // Pular injeção de sharedCaeId se o valor é o CAE desta própria stack.
        if (p === 'sharedCaeId' && ownSharedCaeId && value === ownSharedCaeId) continue;
        paramValues.push(`${p}=${value}`);
        // Sem erro se ausente — o default '' é válido (subscrição condicional não é criada)
      }
    }
    // Separa parâmetros em plain (podem ir na command line) e secret (jamais na
    // command line — seriam visíveis em `ps aux` para qualquer processo local).
    const plainParams = paramValues.filter(p => !isSecretParam(p));
    const secretParams = paramValues.filter(p => isSecretParam(p));

    // displayArgs: versão mascarada usada em --dry-run e mensagens de erro.
    // Nunca expõe valores reais — substitui o value de cada secret por "***".
    const displayArgs = [...args];
    if (paramValues.length > 0) {
      displayArgs.push(
        '--parameters',
        ...plainParams,
        ...secretParams.map(p => `${p.split('=')[0]}=***`),
      );
    }

    if (secretParams.length > 0 && !ctx.dryRun) {
      // Deploy real com secrets: escreve num arquivo temporário fora do repo,
      // com permissão 0600 (só o processo corrente pode ler), e passa @arquivo
      // para o az. O arquivo é apagado no finally via cleanup(), mesmo se o
      // deploy falhar — nunca fica em disco após o comando.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto') as typeof import('crypto');
      const tmpFile = path.join(
        os.tmpdir(),
        `iacmp-params-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`,
      );
      const armParameters: Record<string, { value: string }> = {};
      for (const p of secretParams) {
        const eqIdx = p.indexOf('=');
        armParameters[p.slice(0, eqIdx)] = { value: p.slice(eqIdx + 1) };
      }
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({
          $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
          contentVersion: '1.0.0.0',
          parameters: armParameters,
        }),
        { mode: 0o600 },
      );
      // args reais: params plain inline + secrets via @arquivo (nunca na command line)
      if (paramValues.length > 0) {
        args.push('--parameters', ...plainParams, `@${tmpFile}`);
      }
      commands.push({
        bin: 'az',
        args,
        displayArgs,
        preRun: () => waitForStackTerminal(ctx.stackName, resourceGroup),
        cleanup: () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } },
        onError: () => recoverFromAzCliCrash(ctx.stackName, resourceGroup),
      });
    } else {
      // dry-run (comando não será executado) ou sem secrets: params inline.
      // Em dry-run, args contém os valores reais mas printPlan usa displayArgs
      // (mascarado) — os secrets nunca chegam ao terminal.
      if (paramValues.length > 0) {
        args.push('--parameters', ...paramValues);
      }
      commands.push({ bin: 'az', args, displayArgs, preRun: () => waitForStackTerminal(ctx.stackName, resourceGroup), onError: () => recoverFromAzCliCrash(ctx.stackName, resourceGroup) });
    }

    commands.push(...zipCmds);

    // Ativação de static website — data-plane, não configurável via ARM/Bicep.
    // Para cada output *StaticWebsiteAccount emitido pelo synth, roda pós-deploy:
    //   az storage blob service-properties update --static-website ...
    // O preRun lê os outputs da stack recém-deployada para obter o nome da conta.
    if (!ctx.dryRun) {
      const staticWebKeys = getStaticWebsiteOutputKeys(ctx.templatePath);
      for (const accKey of staticWebKeys) {
        const idxKey = accKey.replace(/StaticWebsiteAccount$/, 'StaticWebsiteIndex');
        const errKey = accKey.replace(/StaticWebsiteAccount$/, 'StaticWebsite404');
        const lazyCmd: NativeCommand = { bin: 'az', args: ['version', '--output', 'none'] };
        lazyCmd.preRun = () => {
          const outputs = getAzureStackOutputs(ctx.stackName, resourceGroup);
          const byLow = new Map(Object.entries(outputs).map(([k, v]) => [k.toLowerCase(), v]));
          const accountName = byLow.get(accKey.toLowerCase());
          if (!accountName) {
            process.stdout.write(t(
              `[iacmp] Output "${accKey}" não encontrado — static website não ativado.\n`,
              `[iacmp] Output "${accKey}" not found — static website not enabled.\n`,
            ));
            return;
          }
          const indexDoc = byLow.get(idxKey.toLowerCase()) ?? 'index.html';
          const errorDoc = byLow.get(errKey.toLowerCase()) ?? '404.html';
          process.stdout.write(t(
            `[iacmp] Ativando static website em "${accountName}" (index: ${indexDoc}, 404: ${errorDoc})...\n`,
            `[iacmp] Enabling static website on "${accountName}" (index: ${indexDoc}, 404: ${errorDoc})...\n`,
          ));
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { execFileSync } = require('child_process') as typeof import('child_process');
          execFileSync('az', [
            'storage', 'blob', 'service-properties', 'update',
            '--account-name', accountName,
            '--static-website',
            '--index-document', indexDoc,
            '--404-document', errorDoc,
            '--auth-mode', 'login',
          ], { stdio: 'inherit' });
          process.stdout.write(t(
            `[iacmp] Static website ativado em "${accountName}".\n`,
            `[iacmp] Static website enabled on "${accountName}".\n`,
          ));
          // O comando principal (az version) passa a ser no-op — todo o trabalho
          // foi feito no preRun via execFileSync.
        };
        commands.push(lazyCmd);
      }
    }

    return commands;
  },

  async planDestroy(ctx: DestroyContext): Promise<NativeCommand[]> {
    const resourceGroup = requireResourceGroup(ctx);
    const commands: NativeCommand[] = [{
      bin: 'az',
      args: [
        'stack', 'group', 'delete',
        '--name', ctx.stackName,
        '--resource-group', resourceGroup,
        '--action-on-unmanage', 'deleteAll',
        '--yes',
      ],
    }];

    // Limpa só o repositório de imagem do projeto no ACR de bootstrap — o ACR em
    // si é compartilhado entre projetos (resource group próprio) e nunca é
    // destruído por aqui. Tolerante à ausência (repo/ACR já não existir).
    if (ctx.templatePath) {
      const metaPath = ctx.templatePath.replace(/\.bicep$/, '.iacmp-meta.json');
      const containerBuilds: AzureContainerBuildMeta[] = fs.existsSync(metaPath)
        ? ((JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { containerBuilds?: AzureContainerBuildMeta[] }).containerBuilds ?? [])
        : [];
      for (const build of containerBuilds) {
        // Placeholder no-op — o trabalho real acontece no preRun (lazy), pra não
        // rodar `az account show` durante --dry-run (planDestroy não tem ctx.dryRun).
        const lazyCmd: NativeCommand = { bin: 'az', args: ['version', '--output', 'none'] };
        lazyCmd.preRun = () => {
          // O nome real do ACR pode ter sido um fallback persistido (ver ensureBootstrapAcr) —
          // nunca assume o determinístico sem checar o estado primeiro.
          const acrName = readBootstrapState().acrName ?? acrBootstrapName(getSubscriptionId());
          process.stdout.write(t(
            `[iacmp] Removendo repositório ACR "${build.repository}" (imagem de "${build.constructId}")...\n`,
            `[iacmp] Removing ACR repository "${build.repository}" (image of "${build.constructId}")...\n`,
          ));
          try {
            execFileSync('az', [
              'acr', 'repository', 'delete',
              '--name', acrName,
              '--repository', build.repository,
              '--yes',
            ], { stdio: 'pipe' });
            process.stdout.write(t(
              `[iacmp] Repositório "${build.repository}" removido.\n`,
              `[iacmp] Repository "${build.repository}" removed.\n`,
            ));
          } catch {
            process.stdout.write(t(
              `[iacmp] Repositório "${build.repository}" não encontrado no ACR (ok, nada a limpar).\n`,
              `[iacmp] Repository "${build.repository}" not found in ACR (ok, nothing to clean).\n`,
            ));
          }
        };
        commands.push(lazyCmd);
      }
    }

    return commands;
  },

  describeStatus(stackName: string, ctx: { resourceGroup?: string }): StackStatus {
    if (!ctx.resourceGroup) return { deployed: false };
    return describeStackStatus(stackName, ctx.resourceGroup);
  },

  async pollStatus(stackName: string, ctx: { resourceGroup?: string }): Promise<string | null> {
    if (!ctx.resourceGroup) return null;
    try {
      const out = execFileSync('az', [
        'stack', 'group', 'show',
        '--name', stackName,
        '--resource-group', ctx.resourceGroup,
        '--query', 'provisioningState',
        '--output', 'tsv',
      ], { stdio: 'pipe' }).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  },
};
