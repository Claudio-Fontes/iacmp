import * as fs from 'fs';
import * as path from 'path';
import { GCPProvider, extractGCPFunctionMeta, extractGCPContainerMeta } from '@iacmp/provider-gcp';
import { Stack } from '@iacmp/core';
import { LoadedStack } from '../validators';
import { providerOutDir } from '../synth-out';
import { SynthUI } from './types';
import { t } from '../i18n';

export function synthGcp(o: {
  cwd: string;
  targetStacks: LoadedStack[];
  allStacks: Stack[];
  ui: SynthUI;
}): void {
  const provOutDir = providerOutDir(o.cwd, 'gcp');
  fs.mkdirSync(provOutDir, { recursive: true });

  for (const { stackName, stack } of o.targetStacks) {
    try {
      const p = new GCPProvider();
      // Só resource{}/output{} por stack — os blocos compartilhados
      // (terraform/provider/variable) são escritos UMA vez em
      // `_providers.tf.json` após este loop (ver abaixo). O Terraform
      // combina todo *.tf.json do diretório num root module único;
      // declarar esses blocos por stack duplicaria e o `terraform
      // validate`/`plan` do diretório inteiro abortaria.
      const tfJson = p.synthesizeResources(stack, o.allStacks);
      const outPath = path.join(provOutDir, `${stackName}.tf.json`);
      fs.writeFileSync(outPath, tfJson);
      // Sidecar lido pelo deploy (packages/cli/src/deploy/gcp.ts) para
      // saber quais Fn.Lambda desta stack precisam de bundle+zip+upload
      // pro bucket de artefatos ANTES do `terraform apply` — mesmo
      // padrão do `.iacmp-meta.json` do Azure.
      const gcpFnMeta = extractGCPFunctionMeta(stack);
      const gcpContainerMeta = extractGCPContainerMeta(stack);
      if (gcpFnMeta.length > 0 || gcpContainerMeta.length > 0) {
        const metaContent: Record<string, unknown> = {};
        if (gcpFnMeta.length > 0) metaContent.functions = gcpFnMeta;
        if (gcpContainerMeta.length > 0) metaContent.containers = gcpContainerMeta;
        fs.writeFileSync(
          path.join(provOutDir, `${stackName}.iacmp-meta.json`),
          JSON.stringify(metaContent, null, 2),
        );
      }
      o.ui.log(t(`Sintetizado: ${outPath}`, `Synthesized: ${outPath}`));
    } catch (err) {
      o.ui.error(t(`Falha ao sintetizar '${stackName}': ${(err as Error).message}`, `Failed to synthesize '${stackName}': ${(err as Error).message}`));
    }
  }

  // ── Bloco compartilhado do projeto inteiro (uma vez por diretório) ──────
  // `terraform{required_providers}` + `provider{}` + `variable{}` unificados
  // (união de TODAS as stacks carregadas, não só as sintetizadas nesta
  // rodada com --stack — o arquivo é do diretório, não de uma stack). Roda
  // depois do loop acima para nunca conviver com um `<stack>.tf.json` que
  // ainda carregue esses blocos (synth parcial de um projeto sintetizado
  // com uma versão anterior do CLI, por ex.).
  try {
    const p = new GCPProvider();
    const providersJson = p.synthesizeProviders(o.allStacks);
    const providersPath = path.join(provOutDir, '_providers.tf.json');
    fs.writeFileSync(providersPath, providersJson);
    o.ui.log(t(`Sintetizado: ${providersPath}`, `Synthesized: ${providersPath}`));
  } catch (err) {
    o.ui.error(t(`Falha ao sintetizar blocos compartilhados do GCP (_providers.tf.json): ${(err as Error).message}`, `Failed to synthesize GCP shared blocks (_providers.tf.json): ${(err as Error).message}`));
  }
}
