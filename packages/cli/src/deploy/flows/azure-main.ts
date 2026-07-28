import * as fs from 'fs';
import { errMessage } from '../../utils';
import { countResources, AZURE_MAIN_STACK } from '../../synth-out';
import { getAzureStackOutputs } from '../azure';
import { printPlan, runCommands } from '../exec';
import { DeployContext } from '../types';
import { DeployFlowOptions } from './common';

/**
 * Deployment único do Azure (_main.bicep): as stacks são módulos de UM
 * template — o ARM resolve ordem e cross-refs sozinho (referência simbólica),
 * sem acumulador de outputs nem injeção manual de params entre stacks.
 *
 * 2º passo: params do main com default '' (ciclos reais, ex: Event Grid
 * precisa do FQDN da function que só existe pós-deploy) são satisfeitos pelos
 * outputs re-exportados após o 1º passo.
 */
export async function deployAzureMain(o: DeployFlowOptions, azureMainPath: string): Promise<void> {
  if (o.stackFlag) {
    o.ui.error(
      'Este projeto usa deployment único no Azure (_main.bicep) — --stack não se aplica: ' +
      'o ARM ordena e deploya os módulos juntos. Rode "iacmp deploy --provider azure" sem --stack.',
    );
  }
  for (const t of o.templates) {
    o.ui.log(`Stack: ${t.stackName} — ${countResources(t.filePath, o.provider)} recurso(s) (módulo)`);
  }
  o.ui.log('');
  const mainStackName = o.physicalStackName(AZURE_MAIN_STACK);
  // Outputs de um deploy anterior: satisfazem params de 2º passo (ex: FQDN de
  // Event Grid) já na 1ª passada de um RE-deploy.
  const before = o.dryRun ? {} : getAzureStackOutputs(mainStackName, o.config.resourceGroup!);
  const ctx: DeployContext = {
    ...o.baseCtx,
    stackName: mainStackName,
    templatePath: azureMainPath,
    ...(Object.keys(before).length > 0 ? { outputParams: { ...before } } : {}),
  };
  let commands;
  try {
    commands = await o.executor.planDeploy(ctx);
  } catch (err) {
    o.ui.error(errMessage(err));
  }
  if (o.dryRun) {
    printPlan(commands);
    return;
  }
  try {
    await runCommands(commands, { executor: o.executor, ctx });
  } catch (err) {
    o.ui.error(errMessage(err));
  }

  // 2º passo: só roda se o valor NÃO existia antes do 1º passo (senão já foi
  // injetado lá).
  const after = getAzureStackOutputs(mainStackName, o.config.resourceGroup!);
  const afterLower = new Map(Object.entries(after).map(([k, v]) => [k.toLowerCase(), v]));
  const beforeLower = new Map(Object.entries(before).map(([k, v]) => [k.toLowerCase(), v]));
  const satisfied: string[] = [];
  for (const line of fs.readFileSync(azureMainPath, 'utf-8').split('\n')) {
    const m = line.match(/^param\s+(\w+)\s+string\s*=\s*''\s*$/);
    if (!m) continue;
    const value = afterLower.get(m[1].toLowerCase());
    if (value && value !== beforeLower.get(m[1].toLowerCase())) satisfied.push(m[1]);
  }
  if (satisfied.length > 0) {
    o.ui.log(`\n2º passo (params agora disponíveis: ${satisfied.join(', ')})`);
    const ctx2: DeployContext = { ...ctx, outputParams: { ...after } };
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
  }
}
