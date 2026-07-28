import * as fs from 'fs';
import chalk from 'chalk';
import { errMessage } from '../../utils';
import { countResources, awsTemplateRegionMarker } from '../../synth-out';
import { getAzureStackOutputs } from '../azure';
import { findExistingRetainedResources, deleteResourceAndWait } from '../aws';
import { printPlan, runCommands } from '../exec';
import { DeployContext } from '../types';
import { confirm, DeployFlowOptions } from './common';

/**
 * Deploy por stack (AWS / Azure layout legado multi-deployment / GCP):
 * um deployment por template, na ordem de dependência. Inclui:
 * - AWS: região de DR por stack + checagem de recursos órfãos (Retain)
 * - Azure: acumulador de outputs entre stacks + 2º passo para params opcionais
 */
export async function deployStackLoop(o: DeployFlowOptions): Promise<void> {
  // Acumula outputs de stacks Azure deployadas para injetar como params na próxima.
  // (Só no layout LEGADO multi-deployment — o modo _main.bicep não passa por aqui.)
  // Pré-popula com outputs de stacks já deployadas no RG (necessário para --stack,
  // que pula stacks anteriores e precisa do sharedCaeId etc já disponível).
  // EXCEÇÃO: nunca pré-popula outputs da própria stack sendo re-deployada — evita
  // injetar sharedCaeId da stack como input dela mesma, o que removeria o CAE do
  // template (if empty(sharedCaeId)) e causaria DeploymentStackDeleteResourcesFailed.
  const azureOutputAccumulator: Record<string, string> = {};
  if (o.provider === 'azure' && o.config.resourceGroup && !o.dryRun) {
    for (const t of o.allTemplates) {
      if (o.stackFlag && t.stackName === o.stackFlag) continue;
      const existing = getAzureStackOutputs(o.physicalStackName(t.stackName), o.config.resourceGroup);
      Object.assign(azureOutputAccumulator, existing);
    }
  }

  for (const t of o.templates) {
    const resourceCount = countResources(t.filePath, o.provider);

    // Stack AWS marcada com region: 'dr' deploya na drRegion do iacmp.json
    // (ex: bucket de DR do CloudFront Origin Group em outra região).
    let stackRegion = o.region;
    if (o.provider === 'aws' && awsTemplateRegionMarker(t.filePath) === 'dr') {
      if (!o.config.drRegion) {
        o.ui.error(`Stack "${t.stackName}" está marcada para a região de DR, mas o iacmp.json não tem "drRegion". Configure (ex: "drRegion": "us-west-2").`);
      }
      stackRegion = o.config.drRegion;
      o.ui.log(`Stack: ${t.stackName} — ${resourceCount} recurso(s) [DR: ${stackRegion}]`);
    } else {
      o.ui.log(`Stack: ${t.stackName} — ${resourceCount} recurso(s)`);
    }

    // Recursos com DeletionPolicy Retain/Snapshot (bancos de dados, etc.)
    // sobrevivem à destruição da stack — uma stack anterior destruída pode
    // deixar um recurso vivo, órfão, fora do controle do CloudFormation.
    // Checagem genérica via Cloud Control API (qualquer Type), não
    // amarrada a um serviço específico. Sem isso, o deploy só descobre o
    // conflito depois de tentar criar o changeset, com um erro confuso
    // (ResourceExistenceCheck).
    if (o.provider === 'aws' && !o.dryRun) {
      const conflicts = findExistingRetainedResources(t.filePath, stackRegion, o.physicalStackName(t.stackName));
      if (conflicts.length > 0) {
        const list = conflicts.map((c) => `${c.typeName} "${c.identifier}"`).join(', ');
        o.ui.log(chalk.red(
          `\n⚠ ATENÇÃO: a stack "${t.stackName}" criaria recurso(s) que JÁ EXISTEM na conta AWS: ${list} — provavelmente retidos de uma stack anterior destruída.`
        ));
        // Sob stdin não-interativo o readline nunca resolve — o processo saía
        // com exit 0 SEM deployar nada, parecendo sucesso (abort silencioso que
        // mordeu a bateria 3×). Não-TTY: exige --yes explícito ou falha ALTO.
        let proceed: boolean;
        if (o.yes) {
          o.ui.log(chalk.yellow('--yes: apagando recurso(s) órfão(s) e continuando.'));
          proceed = true;
        } else if (!process.stdin.isTTY) {
          o.ui.error(
            `Recurso(s) órfão(s) detectado(s) e stdin não é interativo — não há como confirmar. ` +
            `Rode com --yes para apagar e continuar, ou apague/importe manualmente: ${list}`,
          );
        } else {
          proceed = await confirm(
            `Apagar o(s) recurso(s) existente(s) e continuar o deploy de "${t.stackName}"? Isso é IRREVERSÍVEL e PERDE os dados atuais`
          );
        }
        if (!proceed) {
          o.ui.log(chalk.yellow(`Pulando "${t.stackName}" — apague ou importe o(s) recurso(s) manualmente e rode o deploy de novo.\n`));
          continue;
        }
        for (const c of conflicts) {
          await deleteResourceAndWait(c.typeName, c.identifier, stackRegion);
        }
      }
    }

    const ctx: DeployContext = {
      ...o.baseCtx,
      region: stackRegion,
      stackName: o.physicalStackName(t.stackName),
      templatePath: t.filePath,
      ...(o.provider === 'azure' && Object.keys(azureOutputAccumulator).length > 0
        ? { outputParams: { ...azureOutputAccumulator } }
        : {}),
    };

    let commands;
    try {
      commands = await o.executor.planDeploy(ctx);
    } catch (err) {
      o.ui.error(errMessage(err));
    }

    if (o.dryRun) {
      printPlan(commands);
    } else {
      try {
        await runCommands(commands, { executor: o.executor, ctx });
      } catch (err) {
        o.ui.error(errMessage(err));
      }
      // Azure: coleta outputs desta stack para injetar como params na próxima
      if (o.provider === 'azure' && o.config.resourceGroup) {
        const stackOutputs = getAzureStackOutputs(o.physicalStackName(t.stackName), o.config.resourceGroup);
        Object.assign(azureOutputAccumulator, stackOutputs);
      }
    }
    o.ui.log('');
  }

  // Segundo passo Azure: re-deploya stacks que têm params opcionais (default '')
  // agora satisfeitos pelos outputs acumulados das stacks já deployadas.
  // Isso quebra o ciclo bucket↔lambda para Event Grid subscriptions cross-stack:
  // 1º passo cria o bucket (sem a subscription), 2º passo cria a subscription
  // depois que o FQDN da lambda está disponível.
  if (o.provider === 'azure' && !o.dryRun && Object.keys(azureOutputAccumulator).length > 0) {
    await azureSecondPass(o, azureOutputAccumulator);
  }
}

async function azureSecondPass(o: DeployFlowOptions, azureOutputAccumulator: Record<string, string>): Promise<void> {
  const outputsByLower = new Map(
    Object.entries(azureOutputAccumulator).map(([k, v]) => [k.toLowerCase(), v]),
  );
  for (const t of o.templates) {
    let content: string;
    try { content = fs.readFileSync(t.filePath, 'utf-8'); } catch { continue; }
    // Encontra params com default '' que agora têm valor nos outputs acumulados.
    // sharedCaeId é excluído: resolvido pela ordem do 1º passo (não pelo 2º).
    // Reinjetar sharedCaeId na stack que criou o CAE causaria deleção do recurso.
    const SECOND_PASS_SKIP = new Set(['sharedCaeId']);
    const satisfiedOptionals: string[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(/^param\s+(\w+)\s+string\s*=\s*''\s*$/);
      if (!m) continue;
      const paramName = m[1];
      if (SECOND_PASS_SKIP.has(paramName)) continue;
      const value = outputsByLower.get(paramName.toLowerCase());
      if (value) satisfiedOptionals.push(paramName);
    }
    if (satisfiedOptionals.length === 0) continue;
    o.ui.log(`Stack: ${t.stackName} — 2º passo (params agora disponíveis: ${satisfiedOptionals.join(', ')})`);
    const ctx2: DeployContext = {
      ...o.baseCtx,
      stackName: o.physicalStackName(t.stackName),
      templatePath: t.filePath,
      outputParams: { ...azureOutputAccumulator },
    };
    let commands2;
    try {
      commands2 = await o.executor.planDeploy(ctx2);
    } catch (err) {
      o.ui.error(errMessage(err));
    }
    try {
      await runCommands(commands2, { executor: o.executor, ctx: ctx2 });
    } catch (err) {
      o.ui.error(errMessage(err));
    }
    if (o.config.resourceGroup) {
      const stackOutputs = getAzureStackOutputs(o.physicalStackName(t.stackName), o.config.resourceGroup);
      Object.assign(azureOutputAccumulator, stackOutputs);
    }
    o.ui.log('');
  }
}
