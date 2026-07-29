import chalk from 'chalk';
import { t } from '../../i18n';
import { errMessage } from '../../utils';
import { awsTemplateRegionMarker } from '../../synth-out';
import { printPlan, runCommands } from '../exec';
import { DestroyContext } from '../types';
import { DestroyFlowOptions } from './common';

/**
 * Destroy por stack (AWS / Azure layout legado / GCP): um destroy por
 * template, em ordem REVERSA de dependência. Stacks não deployadas são
 * puladas (evita erro "not found" nos deployers nativos).
 */
export async function destroyStackLoop(o: DestroyFlowOptions): Promise<void> {
  for (const tpl of o.templates) {
    // Stack AWS marcada com region: 'dr' vive na drRegion do iacmp.json.
    let stackRegion = o.region;
    if (o.provider === 'aws' && awsTemplateRegionMarker(tpl.filePath) === 'dr') {
      if (!o.config.drRegion) {
        o.ui.error(t(
          `Stack "${tpl.stackName}" está marcada para a região de DR, mas o iacmp.json não tem "drRegion".`,
          `Stack "${tpl.stackName}" is marked for the DR region, but iacmp.json has no "drRegion".`,
        ));
      }
      stackRegion = o.config.drRegion;
    }
    const stackCtx = { ...o.baseCtx, region: stackRegion };

    // Em modo real (não dry-run), pular stacks que não estão deployadas para evitar erro "not found"
    if (!o.dryRun && o.executor.describeStatus) {
      const status = o.executor.describeStatus(o.physicalStackName(tpl.stackName), stackCtx);
      if (!status.deployed) {
        o.ui.log(`Stack: ${tpl.stackName} ${chalk.yellow(t('(não deployada — ignorada)', '(not deployed — skipped)'))}`);
        o.ui.log('');
        continue;
      }
    }

    o.ui.log(`Stack: ${tpl.stackName}${stackRegion !== o.region ? ` [DR: ${stackRegion}]` : ''}`);
    const ctx: DestroyContext = { ...stackCtx, stackName: o.physicalStackName(tpl.stackName), templatePath: tpl.filePath };

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
    o.ui.log('');
  }
}
