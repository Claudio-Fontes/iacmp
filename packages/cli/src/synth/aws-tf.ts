import * as fs from 'fs';
import * as path from 'path';
import { TerraformProvider } from '@iacmp/provider-terraform';
import { Stack, EnvironmentProfile } from '@iacmp/core';
import { LoadedStack } from '../validators';
import { providerOutDir } from '../synth-out';
import { SynthUI } from './types';

/**
 * `--provider aws --format tf` — gera Terraform (tf.json) em synth-out/aws-tf/.
 *
 * Diferente do modelo CloudFormation (uma stack = um deployment com
 * Export/ImportValue), o Terraform combina todo *.tf.json do diretório num
 * root module único com state compartilhado. Isso permite:
 *   - resolver referências cross-stack como referência TF direta (sem vars);
 *   - declarar blocos compartilhados (provider, aws_region…) UMA vez.
 */
export function synthAwsTf(o: {
  cwd: string;
  targetStacks: LoadedStack[];
  allStacks: Stack[];
  profile: EnvironmentProfile;
  ui: SynthUI;
}): void {
  const tfDir = providerOutDir(o.cwd, 'terraform');
  fs.mkdirSync(tfDir, { recursive: true });
  const SHARED_VARS = new Set(['aws_region']);
  const SHARED_DATA = new Set(['aws_region', 'aws_caller_identity']);

  // Passo 1: gera todas as stacks em memória e coleta os outputs
  // (description = export name CFN → valor TF). Isso permite resolver
  // importVars cross-stack sem precisar de variáveis de input.
  type RawStack = { stackName: string; full: Record<string, unknown> };
  const rawStacks: RawStack[] = o.targetStacks.map(({ stackName, stack }) => ({
    stackName,
    full: JSON.parse(new TerraformProvider().synthesize(stack, o.allStacks, o.profile)) as Record<string, unknown>,
  }));

  // exportMap: varName (ex: "helloworldpolicystack_helloworldpolicyrole_rolearn")
  //            → TF expression (ex: "${aws_iam_role.helloworldpolicyrole.arn}")
  const exportMap = new Map<string, string>();
  for (const { full } of rawStacks) {
    const outputs = (full.output as Record<string, { value: string; description?: string }>) ?? {};
    for (const [, out] of Object.entries(outputs)) {
      if (out.description) {
        const varName = out.description.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        exportMap.set(varName, out.value);
      }
    }
  }

  // Substitui ${var.X} por referência direta quando X está no exportMap
  function resolveImportVars(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{var\.([a-z0-9_]+)\}/g, (match, varName: string) =>
        exportMap.has(varName) ? exportMap.get(varName)! : match,
      );
    }
    if (Array.isArray(obj)) return obj.map(resolveImportVars);
    if (typeof obj === 'object' && obj !== null) {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, resolveImportVars(v)]),
      );
    }
    return obj;
  }

  // Terraform executa no diretório synth-out/aws-tf/, então caminhos
  // relativos como "dist/handlers/foo" ficam errados. Tornamos absolutos
  // usando o cwd do projeto (onde iacmp synth foi invocado).
  function makePathsAbsolute(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(makePathsAbsolute);
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        if ((k === 'source_dir' || k === 'output_path') && typeof v === 'string' && !path.isAbsolute(v)) {
          return [k, path.join(o.cwd, v)];
        }
        return [k, makePathsAbsolute(v)];
      }),
    );
  }

  // Passo 2: acumula blocos compartilhados de TODAS as stacks antes de
  // escrever _providers.tf.json — data sources como aws_region.current
  // podem aparecer em qualquer stack, não só na primeira.
  const mergedSharedVars: Record<string, unknown> = {};
  const mergedSharedData: Record<string, unknown> = {};
  let sharedTerraform: unknown;
  let sharedProvider: unknown;
  const perStack: Array<{ stackName: string; stackOut: Record<string, unknown> }> = [];

  for (const { stackName, full } of rawStacks) {
    sharedTerraform ??= full.terraform;
    sharedProvider ??= full.provider;
    const allVars = (full.variable as Record<string, unknown>) ?? {};
    const allData = (full.data as Record<string, unknown>) ?? {};
    const stackVars: Record<string, unknown> = {};
    const stackData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(allVars)) {
      if (SHARED_VARS.has(k)) { mergedSharedVars[k] = v; continue; }
      if (exportMap.has(k)) continue; // import var resolvido — descarta
      stackVars[k] = v;
    }
    for (const [k, v] of Object.entries(allData)) {
      if (SHARED_DATA.has(k)) { mergedSharedData[k] = v; continue; }
      stackData[k] = v;
    }
    const stackOut: Record<string, unknown> = {};
    if (Object.keys(stackVars).length > 0) stackOut.variable = stackVars;
    if (Object.keys(stackData).length > 0) stackOut.data = makePathsAbsolute(stackData);
    if (full.resource) stackOut.resource = resolveImportVars(full.resource);
    if (full.output) stackOut.output = full.output;
    perStack.push({ stackName, stackOut });
  }

  // Escreve _providers.tf.json com todos os blocos compartilhados
  const shared: Record<string, unknown> = { terraform: sharedTerraform, provider: sharedProvider };
  if (Object.keys(mergedSharedVars).length > 0) shared.variable = mergedSharedVars;
  if (Object.keys(mergedSharedData).length > 0) shared.data = mergedSharedData;
  fs.writeFileSync(path.join(tfDir, '_providers.tf.json'), JSON.stringify(shared, null, 2) + '\n');
  o.ui.log(`Sintetizado (aws-tf): ${path.join(tfDir, '_providers.tf.json')}`);

  for (const { stackName, stackOut } of perStack) {
    const outPath = path.join(tfDir, `${stackName}.tf.json`);
    fs.writeFileSync(outPath, JSON.stringify(stackOut, null, 2) + '\n');
    o.ui.log(`Sintetizado (aws-tf): ${outPath}`);
  }
}
