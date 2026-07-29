import { t } from '../../i18n';
import { errMessage } from '../../utils';
import { countResources } from '../../synth-out';
import { commandExists } from '../../commands/doctor';
import { printPlan, runCommands } from '../exec';
import { DestroyContext } from '../types';
import { confirm, DestroyFlowOptions } from './common';

/**
 * Destroy via Terraform (aws-tf / azure-tf): opera no diretório inteiro —
 * executa uma vez, não um loop por stack.
 *
 * Retorna false se o usuário cancelou na confirmação.
 */
export async function destroyTerraformDir(o: DestroyFlowOptions, effectiveProvider: string): Promise<boolean> {
  for (const tpl of o.templates) {
    o.ui.log(t(
      `Stack: ${tpl.stackName} — ${countResources(tpl.filePath, effectiveProvider)} recurso(s)`,
      `Stack: ${tpl.stackName} — ${countResources(tpl.filePath, effectiveProvider)} resource(s)`,
    ));
  }
  o.ui.log('');
  if (!o.force && !o.dryRun) {
    const confirmed = await confirm(t(
      'Tem certeza que deseja destruir todos os recursos?',
      'Are you sure you want to destroy all resources?',
    ));
    if (!confirmed) { o.ui.log(t('Operação cancelada.', 'Operation canceled.')); return false; }
  }
  if (!o.dryRun && !commandExists(o.executor.requiredBinary)) {
    o.ui.error(t(
      `${o.executor.requiredBinary} não encontrado no PATH.`,
      `${o.executor.requiredBinary} not found in PATH.`,
    ));
  }
  const ctx: DestroyContext = { ...o.baseCtx, stackName: o.config.name ?? 'iacmp' };
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
  }
  return true;
}
