import {
  Stack,
  BaseConstruct,
  validateSemantics,
  applyEnvironmentDefaults,
  EnvironmentProfile,
  DEFAULT_PROFILE,
} from '@iacmp/core';
import { type CloudFormationResource, type CloudFormationTemplate, type SynthContext } from './types';
export type { CloudFormationResource, CloudFormationTemplate, SynthContext } from './types';
import { validateResourceReferences, validateNoNullValues } from './validation';
import type { ResourceNode, StackExport, StackGraph } from './graph';
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

export function synthesize(stack: Stack, allStacks?: Stack[], profile: EnvironmentProfile = DEFAULT_PROFILE): CloudFormationTemplate {
  const resources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, { Value: unknown; Export: { Name: string } }> = {};

  // Registry global (constructId → nome da stack que o declara) + roles de
  // Lambda criadas por Policy.IAM — sempre construído a partir de TODAS as
  // stacks quando o chamador tem essa visão (iacmp synth real); sem
  // `allStacks` (testes isolados), usa só a stack atual como universo —
  // mesmo efeito de antes (toda referência resolve local).
  const universe = allStacks ?? [stack];

  // Normalização: preenche defaults derivados do perfil (AZ de subnet, porta do
  // SG do banco) in-place ANTES de validar e emitir — assim os bugs recorrentes
  // deixam de existir na origem, e a validação/synth leem props já consistentes.
  applyEnvironmentDefaults(universe, profile);

  // Validação semântica provider-agnóstica (porta de SG vs engine, cobertura de
  // AZ do RDS, conflito maxAzs/subnets, CIDR, referências quebradas) — roda
  // antes de emitir o template para que esses erros apareçam em synth-time, não
  // no deploy real. O loop do `iacmp ai` captura e reenvia para auto-correção.
  const semanticErrors = validateSemantics(universe, profile);
  if (semanticErrors.length > 0) {
    throw new Error(
      `Validação semântica falhou:\n- ${semanticErrors.join('\n- ')}`,
    );
  }

  const registry = new Map<string, { stackName: string; type: string }>();
  const lambdaRoles = new Map<string, { stackName: string; roleLogicalId: string }>();
  const vpcLambdas = new Set<string>();
  const dbSecretSuffix = new Map<string, string>();
  const sqsEventSourceLambdas = new Set<string>();
  const kinesisEventSourceLambdas = new Set<string>();
  const albDefaultTg = new Map<string, { stackName: string; tgLogicalId: string; listenerLogicalId?: string }>();
  const publicSubnetsByVpc = new Map<string, Array<{ id: string; stackName: string }>>();
  for (const s of universe) {
    for (const c of s.constructs) {
      registry.set(c.id, { stackName: s.name, type: c.type });
      if (c.type === 'Network.Subnet') {
        const p = c.props as Record<string, unknown>;
        if (p.public && typeof p.vpcId === 'string') {
          const arr = publicSubnetsByVpc.get(p.vpcId) ?? [];
          arr.push({ id: c.id, stackName: s.name });
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
          albDefaultTg.set(c.id, { stackName: s.name, tgLogicalId: `${lbLogicalId}TG${tgs[0].name.replace(/[^a-zA-Z0-9]/g, '')}`, listenerLogicalId });
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
            stackName: s.name,
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
      }
      if (c.type === 'Database.DocumentDB') {
        dbSecretSuffix.set(c.id, 'docdb-password');
      }
    }
  }
  const ctx: SynthContext = { currentStackName: stack.name, registry, lambdaRoles, vpcLambdas, dbSecretSuffix, sqsEventSourceLambdas, kinesisEventSourceLambdas, albDefaultTg, publicSubnetsByVpc, profile };

  for (const construct of stack.constructs) {
    const entries = synthesizeConstruct(construct, ctx);
    for (const [id, resource] of entries) {
      resources[id] = resource;
    }
    if (construct.type === 'Network.VPC') {
      const p = construct.props as Record<string, unknown>;
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      synthesizeVPCChildren(logicalId, (p.cidr as string) ?? '10.0.0.0/16', (p.maxAzs as number) ?? 0, resources, outputs, stack.name, construct.id);
      // Exporta sempre — custo zero, e é o que permite outra stack (ou um
      // harness de teste lendo via describe-stacks) referenciar essa VPC pelo
      // ID real em vez de depender da VPC default da conta.
      outputs[`${logicalId}VpcId`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-VpcId` },
      };
    }
    if (construct.type === 'Network.Subnet') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SubnetId`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-SubnetId` },
      };
    }
    if (construct.type === 'Network.SecurityGroup') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}GroupId`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'GroupId'] },
        Export: { Name: `${stack.name}-${construct.id}-GroupId` },
      };
    }
    if (construct.type === 'Secret.Vault') {
      // Ref de AWS::SecretsManager::Secret retorna o ARN — exporta para cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Storage.Bucket') {
      // Nome (Ref) e ARN — para cross-stack (env var BUCKET, policy resources).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Name`] = {
        Value: { Ref: logicalId },
        Export: { Name: `${stack.name}-${construct.id}-Name` },
      };
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Messaging.Queue' || construct.type === 'Messaging.Topic') {
      // ARN (+ URL para fila) — para cross-stack (eventSources, subscriptions, policies).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, construct.type === 'Messaging.Topic' ? 'TopicArn' : 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
      if (construct.type === 'Messaging.Queue') {
        outputs[`${logicalId}QueueUrl`] = {
          Value: { Ref: logicalId },
          Export: { Name: `${stack.name}-${construct.id}-QueueUrl` },
        };
      }
    }
    if (construct.type === 'Messaging.Stream') {
      // ARN do Kinesis stream — para eventSources e policies (kinesis:PutRecord) cross-stack.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Function.Lambda') {
      // Exporta sempre — custo zero, e é o que permite Function.ApiGateway em
      // OUTRA stack referenciar esta Lambda via Fn::ImportValue.
      const lambdaLogicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${lambdaLogicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [lambdaLogicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
      };
    }
    if (construct.type === 'Policy.IAM') {
      const p = construct.props as Record<string, unknown>;
      if (p.attachType === 'lambda') {
        // Exporta o ARN da role pra Function.Lambda em OUTRA stack poder
        // importá-la (resolveLambdaRole, caso cross-stack).
        const roleLogicalId = `${construct.id.replace(/[^a-zA-Z0-9]/g, '')}Role`;
        outputs[`${roleLogicalId}RoleArn`] = {
          Value: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
          Export: { Name: `${stack.name}-${roleLogicalId}-RoleArn` },
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
        Value: { 'Fn::GetAtt': [endpointResource, 'Endpoint.Address'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [endpointResource, 'Endpoint.Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: `${logicalId}Secret` },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Database.DocumentDB') {
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: { 'Fn::GetAtt': [`${logicalId}Cluster`, 'Endpoint'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [`${logicalId}Cluster`, 'Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
      outputs[`${logicalId}SecretArn`] = {
        Value: { Ref: `${logicalId}Secret` },
        Export: { Name: `${stack.name}-${construct.id}-SecretArn` },
      };
    }
    if (construct.type === 'Cache.Redis') {
      // Exporta Endpoint/Port pra Lambda/ECS em OUTRA stack conectar via
      // Fn::ImportValue (REDIS_HOST/REDIS_PORT). ReplicationGroup expõe o
      // primary endpoint em PrimaryEndPoint.Address/Port.
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Endpoint`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Address'] },
        Export: { Name: `${stack.name}-${construct.id}-Endpoint` },
      };
      outputs[`${logicalId}Port`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Port'] },
        Export: { Name: `${stack.name}-${construct.id}-Port` },
      };
    }
    if (construct.type === 'Network.WAF') {
      // Exporta o ARN do WebACL pra um Fn.ApiGateway em OUTRA stack associar (wafAclId).
      const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
      outputs[`${logicalId}Arn`] = {
        Value: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Export: { Name: `${stack.name}-${construct.id}-Arn` },
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
          Value: { Ref: tgLogicalId },
          Export: { Name: `${stack.name}-${construct.id}-TargetGroupArn` },
        };
      }
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

  const graph: StackGraph = { stackName: stack.name, nodes, exports: graphExports };
  const template = emitCloudFormation(graph);

  validateResourceReferences(template.Resources);
  validateNoNullValues(template.Resources);

  return template;
}
