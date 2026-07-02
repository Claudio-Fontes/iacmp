import { BaseConstruct, isRef } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { resolveLambdaArnRef, resolveRef, defaultServiceRole } from '../resolvers';

export function synthWorkflow(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Workflow.StepFunctions': {
      const steps = (props.steps as Array<Record<string, unknown>>) ?? [];
      // Um Task cujo `resource` é o id de uma Fn.Lambda precisa do ARN real no
      // Resource (Step Functions rejeita um id cru). Como a DefinitionString usa
      // Fn::Sub, cada ARN vira uma variável ${...} resolvida no 2º arg do Sub.
      const subVars: Record<string, unknown> = {};
      const definition = {
        Comment: (props.description as string) ?? `Workflow ${construct.id}`,
        StartAt: (steps[0]?.name as string) ?? 'Start',
        States: Object.fromEntries(steps.map((s, i) => {
          const stateType = (s.type as string) ?? 'Task';
          const isTask = stateType === 'Task';
          const isWait = stateType === 'Wait';
          const rawResourceRaw = s.resource;
          const rawResource = isRef(rawResourceRaw) ? rawResourceRaw.constructId : ((rawResourceRaw as string) ?? '');
          // Resolve o id de uma Fn.Lambda pro ARN via variável do Fn::Sub.
          let arnRef: unknown = rawResource;
          if (isTask && rawResource && !rawResource.startsWith('arn:')) {
            // Um Task com resource que não é ARN precisa apontar pra uma Fn.Lambda —
            // um id de outro construct (ou typo) gera uma ASL inválida no deploy.
            if (ctx.registry.get(rawResource)?.type !== 'Function.Lambda') {
              throw new Error(`Workflow.StepFunctions "${construct.id}": o step Task "${s.name}" tem resource "${rawResource}", que não é uma Fn.Lambda nem um ARN. Aponte para o id de uma Fn.Lambda.`);
            }
            const varName = `${(s.name as string).replace(/[^a-zA-Z0-9]/g, '')}Arn`;
            subVars[varName] = isRef(rawResourceRaw) ? resolveRef(rawResourceRaw, ctx) : resolveLambdaArnRef(rawResource, ctx);
            arnRef = `\${${varName}}`;
          }
          // waitForToken: Task de callback — invoca a Lambda passando o task token
          // e PAUSA até SendTaskSuccess/Failure. Usa a integração otimizada
          // lambda:invoke.waitForTaskToken.
          const taskProps = isTask
            ? (s.waitForToken
                ? {
                    Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
                    Parameters: {
                      FunctionName: arnRef,
                      'Payload': { 'taskToken.$': '$$.Task.Token', 'input.$': '$' },
                    },
                  }
                : { Resource: arnRef })
            : {};
          return [s.name as string, {
            Type: stateType,
            ...taskProps,
            // Wait exige Seconds/Timestamp — sem isso a definição é inválida.
            ...(isWait ? { Seconds: (s.seconds as number) ?? 30 } : {}),
            ...(s.description ? { Comment: s.description } : {}),
            ...(i < steps.length - 1 ? { Next: steps[i + 1].name as string } : { End: true }),
          }];
        })),
      };
      const roleLogicalId = `${logicalId}ExecutionRole`;
      // Permissões amplas pros tipos de target mais comuns nos steps de uma
      // state machine — não dá pra saber de antemão quais recursos os `steps`
      // vão invocar. Pra escopo mínimo de verdade, adicione um Policy.IAM
      // (attachType: 'role', attachTo: este id) com os recursos exatos.
      console.warn(`[aws] Workflow.StepFunctions "${construct.id}" usa uma role default com permissões amplas (Lambda/ECS/SNS/SQS/EventBridge) — para produção, escope com Policy.IAM.`);
      return [
        defaultServiceRole(roleLogicalId, 'states.amazonaws.com', [], {
          name: `${logicalId}DefaultPolicy`,
          statements: [{
            Effect: 'Allow',
            Action: [
              'lambda:InvokeFunction',
              'ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks',
              'sns:Publish',
              'sqs:SendMessage',
              'events:PutTargets', 'events:PutRule', 'events:DescribeRule',
              'iam:PassRole',
            ],
            Resource: '*',
          }],
        }),
        [logicalId, {
          Type: 'AWS::StepFunctions::StateMachine',
          Properties: {
            StateMachineName: construct.id,
            StateMachineType: (props.type as string) ?? 'STANDARD',
            DefinitionString: Object.keys(subVars).length > 0
              ? { 'Fn::Sub': [JSON.stringify(definition), subVars] }
              : { 'Fn::Sub': JSON.stringify(definition) },
            RoleArn: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
          },
        }],
      ];
    }

    default: return null;
  }
}
