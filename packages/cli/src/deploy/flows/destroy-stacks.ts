import chalk from 'chalk';
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
  for (const t of o.templates) {
    // Stack AWS marcada com region: 'dr' vive na drRegion do iacmp.json.
    let stackRegion = o.region;
    if (o.provider === 'aws' && awsTemplateRegionMarker(t.filePath) === 'dr') {
      if (!o.config.drRegion) {
        o.ui.error(`Stack "${t.stackName}" está marcada para a região de DR, mas o iacmp.json não tem "drRegion".`);
      }
      stackRegion = o.config.drRegion;
    }
    const stackCtx = { ...o.baseCtx, region: stackRegion };

    // Em modo real (não dry-run), pular stacks que não estão deployadas para evitar erro "not found"
    if (!o.dryRun && o.executor.describeStatus) {
      const status = o.executor.describeStatus(o.physicalStackName(t.stackName), stackCtx);
      if (!status.deployed) {
        o.ui.log(`Stack: ${t.stackName} ${chalk.yellow('(não deployada — ignorada)')}`);
        o.ui.log('');
        continue;
      }
    }

    o.ui.log(`Stack: ${t.stackName}${stackRegion !== o.region ? ` [DR: ${stackRegion}]` : ''}`);
    const ctx: DestroyContext = { ...stackCtx, stackName: o.physicalStackName(t.stackName), templatePath: t.filePath };

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
