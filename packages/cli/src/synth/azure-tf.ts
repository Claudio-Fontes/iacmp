import * as fs from 'fs';
import * as path from 'path';
import { AzureTerraformProvider } from '@iacmp/provider-azure';
import { Stack } from '@iacmp/core';
import { IacmpConfig } from '../utils';
import { LoadedStack } from '../validators';
import { providerOutDir } from '../synth-out';
import { SynthUI } from './types';
import { t } from '../i18n';

/**
 * `--provider azure --format tf` — gera Terraform (provider azurerm) em
 * synth-out/azure-tf/. Blocos compartilhados (terraform/provider/variable/RG)
 * vão UMA vez em _providers.tf.json; cada stack só carrega resource/output.
 */
export function synthAzureTf(o: {
  cwd: string;
  targetStacks: LoadedStack[];
  allStacks: Stack[];
  config: IacmpConfig;
  ui: SynthUI;
}): void {
  const atProvider = new AzureTerraformProvider();
  const tfDir = providerOutDir(o.cwd, 'azure-tf');
  fs.mkdirSync(tfDir, { recursive: true });

  for (const { stackName, stack } of o.targetStacks) {
    const tfJson = atProvider.synthesizeResources(stack, o.allStacks);
    const outPath = path.join(tfDir, `${stackName}.tf.json`);
    fs.writeFileSync(outPath, tfJson);
    o.ui.log(t(`Sintetizado (azure-tf): ${outPath}`, `Synthesized (azure-tf): ${outPath}`));
  }

  const location = o.config.region ?? 'eastus2';
  const resourceGroup = o.config.resourceGroup ?? `${o.config.name ?? 'iacmp'}-rg`;
  const providersPath = path.join(tfDir, '_providers.tf.json');
  fs.writeFileSync(providersPath, atProvider.synthesizeProviders(location, resourceGroup));
  o.ui.log(t(`Sintetizado (azure-tf): ${providersPath}`, `Synthesized (azure-tf): ${providersPath}`));
}
