import {
  Stack,
  BaseConstruct,
  prepareStacksForSynth,
  EnvironmentProfile,
  DEFAULT_PROFILE,
  isRef,
} from '@iacmp/core';
import { type CloudFormationResource, type CloudFormationTemplate, type SynthContext } from './types';
export type { CloudFormationResource, CloudFormationTemplate, SynthContext } from './types';
import { validateResourceReferences, validateNoNullValues, validateHandlerEnvVarAccess, validateEnvVarRefs, validateDynamoKeyTypes, validateCreateHandlerUUID, validateUpdateHandlerExpression } from './validation';
import type { ResourceNode, StackExport, StackGraph } from './graph';
import { resourceRef } from './graph';
import { emitCloudFormation } from './emit/cloudformation';
import { synthMonitoring } from './constructs/monitoring';
import { synthWorkflow } from './constructs/workflow';
import { synthMessaging } from './constructs/messaging';
import { synthStorage } from './constructs/storage';
import { synthDatabase } from './constructs/database';
import { synthCompute } from './constructs/compute';
import { synthNetwork, synthesizeVPCChildren } from './constructs/network';
import { synthFunction } from './constructs/function';

function synthesizeConstruct(construct: BaseConstruct, ctx: SynthContext): Array<[string, CloudFormationResource]> {
  return (
    synthCompute(construct, ctx) ??
    synthNetwork(construct, ctx) ??
    synthStorage(construct, ctx) ??
    synthDatabase(construct, ctx) ??
    synthFunction(construct, ctx) ??
    synthMessaging(construct, ctx) ??
    synthWorkflow(construct, ctx) ??
    synthMonitoring(construct, ctx) ??
    (console.warn(`[aws] Construct type '${construct.type}' nao suportado — descartado.`), [])
  );
}

export function buildGraph(stack: Stack, allStacks?: Stack[], profile: EnvironmentProfile = DEFAULT_PROFILE, projectName?: string): StackGraph {
  const resources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, { Value: unknown; Export: { Name: string } }> = {};

  // Registry global (constructId → nome da stack que o declara) + roles de
  // Lambda criadas por Policy.IAM — sempre construído a partir de TODAS as
  // stacks quando o chamador tem essa visão (iacmp synth real); sem
  // `allStacks` (testes isolados), usa só a stack atual como universo —
  // mesmo efeito de antes (toda referência resolve local).
  const universe = allStacks ?? [stack];

  // Quando projectName está presente (synth real com iacmp.json), todos os
  // StackNames físicos e Export Names são prefixados com ele. Isso garante
  // que dois projetos distintos na mesma conta AWS nunca colidam em stacks
  // (`vpc-stack` do p08 vs `vpc-stack` do p09 viram `p08-vpc-stack` e
  // `p09-vpc-stack`). Sem projectName (testes isolados), comportamento idêntico
  // ao anterior — nenhum teste existente é afetado.
  const prefixStack = (name: string): string => projectName ? `${projectName}-${name}` : name;

  // Normaliza (defaults derivados do perfil, in-place) + valida a semântica
  // (porta de SG, AZ do RDS, CIDR, refs quebradas) ANTES de emitir. Ponto de
  // entrada único do core — o MESMO que Azure/GCP chamam, para que a rede de
  // segurança valha para os três providers. Lança em synth-time; o loop do
  // `iacmp ai` captura e reenvia para auto-correção.
  prepareStacksForSynth(universe, profile);

  const registry = new Map<string, { stackName: string; type: string }>();
  const lambdaRoles = new Map<string, { stackName: string; roleLogicalId: string }>();
  const vpcLambdas = new Set<string>();
  const dbSecretSuffix = new Map<string, string>();
  const dbMasterUsername = new Map<string, string>();
  const sqsEventSourceLambdas = new Set<string>();
  const kinesisEventSourceLambdas = new Set<string>();
  const albDefaultTg = new Map<string, { stackName: string; tgLogicalId: string; listenerLogicalId?: string }>();
  const publicSubnetsByVpc = new Map<string, Array<{ id: string; stackName: string }>>();
  const s3TriggerBucketsForLambda = new Map<string, Set<string>>();
  const sfnInitiatorLambdas = new Set<string>();
  for (const s of universe) {
    for (const c of s.constructs) {
      registry.set(c.id, { stackName: prefixStack(s.name), type: c.type });
      if (c.type === 'Network.Subnet') {
        const p = c.props as Record<string, unknown>;
        if (p.public && typeof p.vpcId === 'string') {
          const arr = publicSubnetsByVpc.get(p.vpcId) ?? [];
          arr.push({ id: c.id, stackName: prefixStack(s.name) });
          publicSubnetsByVpc.set(p.vpcId, arr);
        }
      }
      if (c.type === 'Network.LoadBalancer') {
        const lbProps = c.props as Record<string, unknown>;
        const tgs = lbProps.targetGroups as Array<{ name: string }> | undefined;
        if (tgs && tgs.length > 0) {
          const lbLogicalId = c.id.replace(/[^a-zA-Z0-9]/g, '');
          // Descobre o listener que faz forward pro TG default: espelha a numeração
          // do synth (pula HTTPS/TLS sem certificado; o 1º não-redirect faz forward).
          const listeners = (lbProps.listeners as Array<Record<string, unknown>> | undefined) ?? [];
          let idx = 0; let listenerLogicalId: string | undefined;
          for (const l of listeners) {
            if ((l.protocol === 'HTTPS' || l.protocol === 'TLS') && !l.certificateArn) continue;
            idx++;
            if (!l.redirectToHttps && !listenerLogicalId) listenerLogicalId = `${lbLogicalId}Listener${idx}`;
          }
          albDefaultTg.set(c.id, { stackName: prefixStack(s.name), tgLogicalId: `${lbLogicalId}TG${tgs[0].name.replace(/[^a-zA-Z0-9]/g, '')}`, listenerLogicalId });
        }
      }
      if (c.type === 'Function.Lambda' && Array.isArray((c.props as Record<string, unknown>).eventSources)) {
        const es = (c.props as Record<string, unknown>).eventSources as Array<Record<string, unknown>>;
        if (es.some(e => e.queueId)) sqsEventSourceLambdas.add(c.id);
        if (es.some(e => e.streamId)) kinesisEventSourceLambdas.add(c.id);
      }
      if (c.type === 'Policy.IAM') {
        const p = c.props as Record<string, unknown>;
        if (p.attachType === 'lambda' && typeof p.attachTo === 'string') {
          lambdaRoles.set(p.attachTo, {
            stackName: prefixStack(s.name),
            roleLogicalId: `${c.id.replace(/[^a-zA-Z0-9]/g, '')}Role`,
          });
        }
      }
      if (c.type === 'Function.Lambda') {
        const p = c.props as Record<string, unknown>;
        if (p.vpcId) vpcLambdas.add(c.id);
      }
      if (c.type === 'Database.SQL') {
        const p = c.props as Record<string, unknown>;
        const engine = p.engine as string;
        const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';
        dbSecretSuffix.set(c.id, isAurora ? 'aurora-password' : 'db-password');
        dbMasterUsername.set(c.id, engine === 'sqlserver' ? 'sqladmin' : 'dbadmin');
      }
      if (c.type === 'Database.DocumentDB') {
        dbSecretSuffix.set(c.id, 'docdb-password');
        dbMasterUsername.set(c.id, 'docdbadmin');
      }
    }
  }
  // Custom.Resource com AWS::Lambda::EventSourceMapping — detecta o vínculo
  // Lambda→SQS/Kinesis para que a role da Lambda receba as permissões necessárias
  // (AWSLambdaSQSQueueExecutionRole / KinesisExecutionRole). O modelo às vezes usa
  // Custom.Resource em vez de Fn.Lambda.eventSources; sem este passo o deploy
  // falha com "role does not have permissions to call ReceiveMessage on SQS".
  for (const s of universe) {
    for (const c of s.constructs) {
      if (c.type !== 'Custom.Resource') continue;
      const cfn = (c.props as Record<string, unknown>).cloudformation as Record<string, unknown> | undefined;
      if (cfn?.type !== 'AWS::Lambda::EventSourceMapping') continue;
      const props = cfn.properties as Record<string, unknown> | undefined;
      if (!props) continue;
      // Extrai lambdaId de FunctionName: { Ref: 'LambdaId' }
      const fn = props.FunctionName as Record<string, unknown> | undefined;
      const lambdaId = typeof fn?.Ref === 'string' ? fn.Ref : undefined;
      if (!lambdaId || registry.get(lambdaId)?.type !== 'Function.Lambda') continue;
      // Determina tipo da fila: Ref object iacmp:ref ou { 'Fn::ImportValue': 'X.Y' }
      const esa = props.EventSourceArn as Record<string, unknown> | undefined;
      let sourceConstructId: string | undefined;
      if (isRef(esa as unknown)) {
        sourceConstructId = (esa as { constructId: string }).constructId;
      } else if (typeof esa?.['Fn::ImportValue'] === 'string') {
        const raw = esa['Fn::ImportValue'] as string;
        const dot = raw.lastIndexOf('.');
        if (dot > 0) sourceConstructId = raw.slice(0, dot);
      }
      const sourceType = sourceConstructId ? registry.get(sourceConstructId)?.type : undefined;
      if (sourceType === 'Messaging.Queue') sqsEventSourceLambdas.add(lambdaId);
      if (sourceType === 'Messaging.Stream') kinesisEventSourceLambdas.add(lambdaId);
    }
  }

  // Coleta TODOS os erros de constructs antes de lançar — o modelo vê tudo de uma
  // vez e corrige em uma rodada, em vez de corrigir um erro por tentativa.
  const constructErrors: string[] = [];
  try { validateEnvVarRefs(universe, registry); } catch (e) { constructErrors.push((e as Error).message); }
  try { validateDynamoKeyTypes(universe); } catch (e) { constructErrors.push((e as Error).message); }
  if (constructErrors.length > 0) throw new Error(constructErrors.join('\n\n'));

  // Lambdas que têm refs a AWS services no environment — sem Policy.IAM explícito,
  // a default role não inclui essas permissões e o runtime falha com AccessDeniedException.
  const dynamoRefLambdas = new Map<string, Set<string>>();
  const sqsSenderRefLambdas = new Map<string, Set<string>>();
  for (const s of universe) {
    for (const c of s.constructs) {
      if (c.type !== 'Function.Lambda') continue;
      const env = ((c.props as Record<string, unknown>).environment as Record<string, unknown> | undefined) ?? {};
      for (const v of Object.values(env)) {
        if (!isRef(v)) continue;
        const refType = registry.get(v.constructId)?.type;
        if (refType === 'Workflow.StepFunctions') {
          sfnInitiatorLambdas.add(c.id);
        } else if (refType === 'Database.DynamoDB') {
          const set = dynamoRefLambdas.get(c.id) ?? new Set<string>();
          set.add(v.constructId);
          dynamoRefLambdas.set(c.id, set);
        } else if (refType === 'Messaging.Queue') {
          const set = sqsSenderRefLambdas.get(c.id) ?? new Set<string>();
          set.add(v.constructId);
          sqsSenderRefLambdas.set(c.id, set);
        }
      }
    }
  }

  // Buckets S3 (mesma stack) que acionam uma Lambda via eventNotifications.
  // Usado para quebrar o ciclo: Bucket→Permission→Lambda→PolicyRole→Bucket(Arn).
  for (const c of stack.constructs) {
    if (c.type !== 'Storage.Bucket') continue;
    const p = (c.props ?? {}) as Record<string, unknown>;
    const notifications = (p.eventNotifications as Array<Record<string, unknown>> | undefined) ?? [];
    for (const n of notifications) {
      const rawId = n.lambdaId;
      const lambdaId = typeof rawId === 'string' ? rawId : (rawId as Record<string, unknown>)?.constructId as string | undefined;
      if (!lambdaId) continue;
      const lambdaEntry = registry.get(lambdaId);
      if (!lambdaEntry || lambdaEntry.stackName !== prefixStack(stack.name)) continue;
      const set = s3TriggerBucketsForLambda.get(lambdaId) ?? new Set<string>();
      set.add(c.id);
      s3TriggerBucketsForLambda.set(lambdaId, set);
    }
  }
  const ctx: SynthContext = { currentStackName: prefixStack(stack.name), projectName, registry, lambdaRoles, vpcLambdas, dbSecretSuffix, dbMasterUsername, sqsEventSourceLambdas, kinesisEventSourceLambdas, albDefaultTg, publicSubnetsByVpc, profile, s3TriggerBucketsForLambda, sfnInitiatorLambdas, dynamoRefLambdas, sqsSenderRefLambdas };

  // Guard: detecta handlers .ts que leem process.env de env vars omitidas pelo
  // synth (omitidas porque referenciam o bucket-trigger — evitar ciclo CFN).
  // O modelo de IA frequentemente gera essa leitura; sem o guard só falha em runtime.
  // Coleta TODOS os erros de handlers antes de lançar — mesma lógica dos constructs.
  const handlerErrors: string[] = [];
  try { validateHandlerEnvVarAccess(stack.constructs, ctx); } catch (e) { handlerErrors.push((e as Error).message); }
  const hasLambda = stack.constructs.some(c => c.type === 'Function.Lambda');
  if (hasLambda) {
    try { validateCreateHandlerUUID(); } catch (e) { handlerErrors.push((e as Error).message); }
    try { validateUpdateHandlerExpression(); } catch (e) { handlerErrors.push((e as Error).message); }
  }
  if (handlerErrors.length > 0) throw new Error(handlerErrors.join('\n\n'));

  for (const construct of stack.constructs) {
    const entries = synthesizeConstruct(construct, ctx);
    for (const [id, resource] of entries) {
      resources[id] = resource;
    }
    if (construct.type === 'Network.VPC') {
      const p = construct.props as Record<string, unknown>;
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      synthesizeVPCChildren(logicalId, (p.cidr as string) ?? '10.0.0.0/16', (p.maxAzs as number) ?? 0, resources, outputs, prefixStack(stack.name), construct.id);
      // Exporta sempre — custo zero, e é o que permite outra stack (ou um
      // harness de teste lendo via describe-stacks) referenciar essa VPC pelo
      // ID real em vez de depender da VPC default da conta.
      outputs[`${logicalId}VpcId`] = {
        Value: resourceRef(logicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-VpcId` },
      };
    }
    if (construct.type === 'Network.Subnet') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SubnetId`] = {
        Value: resourceRef(logicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-SubnetId` },
      };
    }
    if (construct.type === 'Network.SecurityGroup') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}GroupId`] = {
        Value: resourceRef(logicalId, 'GroupId'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-GroupId` },
      };
    }
    if (construct.type === 'Secret.Vault') {
      // Ref de AWS::SecretsManager::Secret retorna o ARN — exporta para cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SecretArn`] = {
        Value: resourceRef(logicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Storage.Bucket') {
      // Nome (Ref) e ARN — para cross-stack (env var BUCKET, policy resources).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Name`] = {
        Value: resourceRef(logicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Name` },
      };
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Messaging.Queue' || construct.type === 'Messaging.Topic') {
      // ARN (+ URL para fila) — para cross-stack (eventSources, subscriptions, policies).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, construct.type === 'Messaging.Topic' ? 'TopicArn' : 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
      if (construct.type === 'Messaging.Queue') {
        outputs[`${logicalId}QueueUrl`] = {
          Value: resourceRef(logicalId, 'Id'),
          Export: { Name: `${prefixStack(stack.name)}-${construct.id}-QueueUrl` },
        };
      }
    }
    if (construct.type === 'Messaging.Stream') {
      // ARN do Kinesis stream — para eventSources e policies (kinesis:PutRecord) cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Database.DynamoDB') {
      // Nome (Ref) e ARN — para cross-stack (env var TABLE_NAME, policy resources).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Name`] = {
        Value: resourceRef(logicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Name` },
      };
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Function.Lambda') {
      // Exporta sempre — custo zero, e é o que permite Function.ApiGateway em
      // OUTRA stack referenciar esta Lambda via Fn::ImportValue.
      const lambdaLogicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${lambdaLogicalId}Arn`] = {
        Value: resourceRef(lambdaLogicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
      // Nome físico (Ref retorna FunctionName) — permite Monitoring.Alarm/Dashboard
      // em OUTRA stack referenciar a dimension FunctionName pelo nome real
      // (prefixado com o projectName), em vez de hardcodar o id lógico.
      outputs[`${lambdaLogicalId}Name`] = {
        Value: resourceRef(lambdaLogicalId, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Name` },
      };
    }
    if (construct.type === 'Policy.IAM') {
      const p = construct.props as Record<string, unknown>;
      if (p.attachType === 'lambda') {
        // Exporta o ARN da role pra Function.Lambda em OUTRA stack poder
        // importá-la (resolveLambdaRole, caso cross-stack).
        const roleLogicalId = `${construct.id.replace(/[^a-zA-Z0-9]/g, '')}Role`;
        outputs[`${roleLogicalId}RoleArn`] = {
          Value: resourceRef(roleLogicalId, 'Arn'),
          Export: { Name: `${prefixStack(stack.name)}-${roleLogicalId}-RoleArn` },
        };
      }
    }
    if (construct.type === 'Database.SQL') {
      const p = construct.props as Record<string, unknown>;
      const engine = p.engine as string;
      const isAurora = engine === 'aurora-mysql' || engine === 'aurora-postgresql';
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      const endpointResource = isAurora ? `${logicalId}Cluster` : logicalId;
      outputs[`${logicalId}Endpoint`] = {
        Value: resourceRef(endpointResource, 'Endpoint.Address'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: resourceRef(endpointResource, 'Endpoint.Port'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: resourceRef(`${logicalId}Secret`, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Database.DocumentDB') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: resourceRef(`${logicalId}Cluster`, 'Endpoint'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: resourceRef(`${logicalId}Cluster`, 'Port'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: resourceRef(`${logicalId}Secret`, 'Id'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Cache.Redis') {
      // Exporta Endpoint/Port pra Lambda/ECS em OUTRA stack conectar via
      // Fn::ImportValue (REDIS_HOST/REDIS_PORT). ReplicationGroup expõe o
      // primary endpoint em PrimaryEndPoint.Address/Port.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: resourceRef(logicalId, 'PrimaryEndPoint.Address'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: resourceRef(logicalId, 'PrimaryEndPoint.Port'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Port` },
      };
    }
    if (construct.type === 'Workflow.StepFunctions') {
      // Exporta o ARN da state machine pra outra stack referenciar via ref('X','Arn').
      // Ref de AWS::StepFunctions::StateMachine retorna o ARN; GetAtt 'Arn' também.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Network.WAF') {
      // Exporta o ARN do WebACL pra um Fn.ApiGateway em OUTRA stack associar (wafAclId).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: resourceRef(logicalId, 'Arn'),
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Network.LoadBalancer') {
      // Exporta o ARN do target group default pra um Compute.Container em OUTRA
      // stack registrar suas tasks (ECS Service LoadBalancers). Ver resolveTargetGroupArn.
      const tgs = (construct.props as Record<string, unknown>).targetGroups as Array<{ name: string }> | undefined;
      if (tgs && tgs.length > 0) {
        const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
        const tgLogicalId = `${logicalId}TG${tgs[0].name.replace(/[^a-zA-Z0-9]/g, '')}`;
        outputs[`${logicalId}TargetGroupArn`] = {
          Value: resourceRef(tgLogicalId, 'Id'),
          Export: { Name: `${prefixStack(stack.name)}-${construct.id}-TargetGroupArn` },
        };
      }
    }
    if (construct.type === 'Network.CDN') {
      // Exporta o DomainName da distribuição CloudFront — é o que o usuário precisa
      // para apontar o DNS ou testar o site após o deploy.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Url`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'DomainName'] },
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-Url` },
      };
    }
    if (construct.type === 'Function.ApiGateway') {
      // Exporta a invoke URL do API Gateway — usada em testes funcionais e integrações.
      // HTTP/WEBSOCKET v2: GetAtt InvokeUrl do Stage. REST v1: Fn::Sub com o id da API.
      const p = construct.props as Record<string, unknown>;
      const apigwType = (p.type as string) ?? 'HTTP';
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      const stageName = (p.stageName as string) ?? (apigwType === 'REST' ? 'prod' : '$default');
      // Para ambos os tipos (REST e HTTP/v2), a invoke URL é construída via Fn::Sub.
      // AWS::ApiGatewayV2::Stage não expõe InvokeUrl como GetAtt — usar Fn::Sub com
      // o Ref da API (que retorna o apiId) e o nome do stage.
      const urlValue = { 'Fn::Sub': `https://\${${logicalId}}.execute-api.\${AWS::Region}.amazonaws.com/${stageName}` };
      outputs['ApiUrl'] = {
        Value: urlValue,
        Export: { Name: `${prefixStack(stack.name)}-${construct.id}-ApiUrl` },
      };
    }
  }

  const nodes: ResourceNode[] = Object.entries(resources).map(([logicalId, res]) => ({
    logicalId,
    awsType: res.Type,
    properties: res.Properties,
    dependsOn: res.DependsOn ?? [],
    deletionPolicy: res.DeletionPolicy,
  }));

  const graphExports: StackExport[] = Object.entries(outputs).map(([key, out]) => ({
    key,
    name: out.Export.Name,
    value: out.Value,
  }));

  return { stackName: prefixStack(stack.name), nodes, exports: graphExports };
}

export function synthesize(stack: Stack, allStacks?: Stack[], profile: EnvironmentProfile = DEFAULT_PROFILE, projectName?: string): CloudFormationTemplate {
  const graph = buildGraph(stack, allStacks, profile, projectName);
  const template = emitCloudFormation(graph);
  validateResourceReferences(template.Resources);
  validateNoNullValues(template.Resources);
  return template;
}
