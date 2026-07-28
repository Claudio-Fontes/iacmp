import { BaseConstruct, ref } from '@iacmp/core';
import { TFOutput, toTfId, addResource } from './common.js';
import { resolveGcpRef } from '../refs.js';

/**
 * Resolve `step.resource` (id lógico de uma Fn.Lambda/Compute.Container, no
 * padrão usado pelos exemplos GCP e pelo synth AWS equivalente — ver
 * synthWorkflow em packages/providers/aws/src/synth/constructs/workflow.ts)
 * para a URL HTTP real do serviço via o registro global do projeto
 * (buildRegistry em ../refs.ts, o mesmo usado por resolveRefsDeep):
 *   - Function.Lambda  → `${google_cloudfunctions2_function.<id>.service_config[0].uri}`
 *   - Compute.Container → `${google_cloud_run_v2_service.<id>.uri}`
 * Se `resource` já chegou como interpolação `${...}` (ex: usuário passou
 * `fn.ref('Arn')` explicitamente e resolveRefsDeep já resolveu upstream, antes
 * de synthWorkflow ser chamado), usa como está. Se o id não existir no
 * registro ou apontar para um tipo sem URL HTTP conhecida, cai no
 * comportamento anterior (id lógico cru como placeholder) com um aviso — não
 * há como inventar uma URL para um tipo que o synth GCP não sabe expor.
 */
function resolveStepUrl(resource: string | undefined, registry: TFOutput['registry']): string {
  if (!resource) return '';
  if (resource.startsWith('${')) return resource;
  const target = registry.byId.get(resource);
  if (target && (target.type === 'Function.Lambda' || target.type === 'Compute.Container')) {
    return resolveGcpRef(ref(resource, 'Fqdn'), registry) as string;
  }
  console.warn(`[gcp] Workflow.StepFunctions: step com resource "${resource}" não referencia uma Fn.Lambda/Compute.Container conhecida no projeto — mantendo o id lógico como placeholder em vez da URL real.`);
  return resource;
}

export function synthWorkflow(construct: BaseConstruct, ctx: TFOutput): boolean {
  const props = construct.props as Record<string, unknown>;
  const id = toTfId(construct.id);
  const r = ctx.resources;

  switch (construct.type) {

    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      const definition = {
        main: {
          steps: steps.map((s) => {
            const stepType = (s.type as string) ?? 'Task';
            if (stepType === 'Wait') {
              // Cloud Workflows não tem estado "Wait" dedicado — sys.sleep é o
              // equivalente direto (pausa a execução por N segundos).
              return {
                [s.name as string]: {
                  call: 'sys.sleep',
                  args: { seconds: (s.seconds as number) ?? 30 },
                },
              };
            }
            // waitForToken (padrão de aprovação humana do Step Functions) não
            // tem equivalente nativo em Cloud Workflows — chama a function
            // normalmente; documentado no fixture gcp-step-workflow (corpus).
            return {
              [s.name as string]: {
                call: 'http.post',
                args: { url: resolveStepUrl(s.resource as string | undefined, ctx.registry) },
              },
            };
          }),
        },
      };
      addResource(r, 'google_workflows_workflow', id, {
        name: construct.id,
        region: '${var.gcp_region}',
        source_contents: JSON.stringify(definition, null, 2),
      });
      return true;
    }

    default:
      return false;
  }
}
