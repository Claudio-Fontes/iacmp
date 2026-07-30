import * as path from 'path';
import { t } from '../../i18n';
import { errMessage } from '../../utils';
import { providerOutDir, AZURE_MAIN_FILE, AZURE_MAIN_STACK } from '../../synth-out';
import { listApimServices, describeStackStatus, waitForStackTerminal } from '../azure';
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
    o.ui.error(t(
      'Este projeto usa deployment único no Azure (_main.bicep) — --stack não se aplica: ' +
      'o destroy remove a stack "main" inteira. Rode sem --stack.',
      'This project uses a single Azure deployment (_main.bicep) — --stack does not apply: ' +
      'destroy removes the whole "main" stack. Run it without --stack.',
    ));
  }
  const mainStackName = o.physicalStackName(AZURE_MAIN_STACK);
  if (!o.dryRun && o.executor.describeStatus && !o.executor.describeStatus(mainStackName, o.baseCtx).deployed) {
    o.ui.log(t(
      `Stack "${AZURE_MAIN_STACK}" (deployment único) não está deployada — nada a destruir.`,
      `Stack "${AZURE_MAIN_STACK}" (single deployment) is not deployed — nothing to destroy.`,
    ));
    return false;
  }
  o.ui.log(t(
    `Stack: ${AZURE_MAIN_STACK} (deployment único — remove todos os módulos)`,
    `Stack: ${AZURE_MAIN_STACK} (single deployment — removes all modules)`,
  ));
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
      // O `az stack group delete` às vezes perde a conexão local (ou colide com
      // DeploymentStackInNonTerminalState) DEPOIS que a ARM já começou a deletar —
      // recursos como APIM levam minutos. Se a stack está em deleção (ou já sumiu),
      // esperamos o estado terminal em vez de reportar falha — espelho do
      // recoverFromAzCliCrash do deploy. Provado na bateria de validação
      // (cv-az-notes: 2 "falhas" de destroy que eram deleções em andamento).
      const rg = ctx.resourceGroup ?? o.config.resourceGroup ?? '';
      const st = rg ? describeStackStatus(mainStackName, rg) : { deployed: true as const, status: undefined };
      if (!st.deployed) {
        o.ui.log(t('[iacmp] A stack já não existe no ARM — destroy concluído.', '[iacmp] The stack no longer exists in ARM — destroy complete.'));
      } else if (st.status && /delet/i.test(st.status)) {
        o.ui.log(t(
          `[iacmp] O az perdeu a conexão mas a ARM está deletando (estado: ${st.status}). Aguardando...`,
          `[iacmp] az lost the connection but ARM is deleting (state: ${st.status}). Waiting...`,
        ));
        waitForStackTerminal(mainStackName, rg);
        const after = describeStackStatus(mainStackName, rg);
        if (after.deployed) o.ui.error(errMessage(err));
        o.ui.log(t('[iacmp] Deleção concluída pela ARM.', '[iacmp] Deletion completed by ARM.'));
      } else {
        o.ui.error(errMessage(err));
      }
    }
    fireApimPurge(apimsToPurge, o.ui);
    if (o.config.resourceGroup) await maybeDeleteEmptyRg(o.config.resourceGroup, o.force, o.ui);
  }
  return true;
}
