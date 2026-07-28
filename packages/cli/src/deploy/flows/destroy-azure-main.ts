import * as path from 'path';
import { errMessage } from '../../utils';
import { providerOutDir, AZURE_MAIN_FILE, AZURE_MAIN_STACK } from '../../synth-out';
import { listApimServices } from '../azure';
import { printPlan, runCommands } from '../exec';
import { DestroyContext } from '../types';
import { DestroyFlowOptions } from './common';
import { fireApimPurge, maybeDeleteEmptyRg } from './destroy-cleanup';

/**
 * Destroy do deployment único Azure (_main.bicep): destrói UMA deployment
 * stack — a "main", que rastreia todos os recursos dos módulos.
 *
 * Retorna false se não havia nada deployado (já logado).
 */
export async function destroyAzureMain(
  o: DestroyFlowOptions,
  apimsToPurge: ReturnType<typeof listApimServices>,
): Promise<boolean> {
  if (o.stackFlag) {
    o.ui.error(
      'Este projeto usa deployment único no Azure (_main.bicep) — --stack não se aplica: ' +
      'o destroy remove a stack "main" inteira. Rode sem --stack.',
    );
  }
  const mainStackName = o.physicalStackName(AZURE_MAIN_STACK);
  if (!o.dryRun && o.executor.describeStatus && !o.executor.describeStatus(mainStackName, o.baseCtx).deployed) {
    o.ui.log(`Stack "${AZURE_MAIN_STACK}" (deployment único) não está deployada — nada a destruir.`);
    return false;
  }
  o.ui.log(`Stack: ${AZURE_MAIN_STACK} (deployment único — remove todos os módulos)`);
  const ctx: DestroyContext = { ...o.baseCtx, stackName: mainStackName, templatePath: path.join(providerOutDir(o.cwd, 'azure'), AZURE_MAIN_FILE) };
  let commands;
  try {
    commands = await o.executor.planDestroy(ctx);
  } catch (err) {
    o.ui.error(errMessage(err));
  }
  if (o.dryRun) {
    printPlan(commands);
  } else {
    try {
      await runCommands(commands);
    } catch (err) {
      o.ui.error(errMessage(err));
    }
    fireApimPurge(apimsToPurge, o.ui);
    if (o.config.resourceGroup) await maybeDeleteEmptyRg(o.config.resourceGroup, o.force, o.ui);
  }
  return true;
}
