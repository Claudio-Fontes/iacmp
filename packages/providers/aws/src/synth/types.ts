import { EnvironmentProfile } from '@iacmp/core';

export interface CloudFormationResource {
  Type: string;
  DeletionPolicy?: string;
  DependsOn?: string[];
  Properties: Record<string, unknown>;
}

export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Resources: Record<string, CloudFormationResource>;
  Outputs?: Record<string, { Value: unknown; Export: { Name: string } }>;
}

/**
 * Contexto opcional com visão de TODAS as stacks do projeto (não só a atual)
 * — usado por Function.ApiGateway pra resolver referências a Function.Lambda
 * que vivem em outra stack/template (Fn::ImportValue) em vez de assumir que
 * estão sempre na mesma stack (Fn::Sub local, que é o que CloudFormation
 * aceita só quando o recurso está no MESMO template).
 */
export interface SynthContext {
  currentStackName: string;
  /** constructId (ex: 'SaveMessageFn') → nome da Stack que o declara. */
  registry: Map<string, string>;
  /**
   * lambdaId (id de uma Function.Lambda) → role IAM criada por um Policy.IAM
   * (attachType: 'lambda', attachTo: lambdaId) que a referencia, se existir.
   */
  lambdaRoles: Map<string, { stackName: string; roleLogicalId: string }>;
  /** constructId de Database → sufixo do nome do secret (ex: 'AppDB' → 'db-password' ou 'aurora-password'). */
  dbSecretSuffix: Map<string, string>;
  /** IDs de Secret.Vault — o próprio logicalId É o secret (Ref retorna o ARN). */
  secretVaults: Set<string>;
  /** IDs de Storage.Bucket — para resolver ARN/nome em policies e env vars. */
  s3Buckets: Set<string>;
  /** IDs de Fn.Lambda com eventSources SQS — a role precisa da SQSQueueExecutionRole. */
  sqsEventSourceLambdas: Set<string>;
  /** IDs de Fn.Lambda com eventSources Kinesis — a role precisa da KinesisExecutionRole. */
  kinesisEventSourceLambdas: Set<string>;
  /** IDs de Function.Lambda que têm vpcId definido — precisam de VPCAccessExecutionRole. */
  vpcLambdas: Set<string>;
  /** constructId de Network.LoadBalancer → target group default (1º) e o listener que
   *  faz forward pra ele (para o ECS Service depender do listener certo). */
  albDefaultTg: Map<string, { stackName: string; tgLogicalId: string; listenerLogicalId?: string }>;
  /** IDs de Function.Lambda — alvos válidos de rotas de Function.ApiGateway. */
  lambdaConstructs: Set<string>;
  /** vpcId (construct id) → Network.Subnet com public:true que o referenciam (para IGW + rota pública). */
  publicSubnetsByVpc: Map<string, Array<{ id: string; stackName: string }>>;
  /** Perfil de ambiente (tier da conta, região) — fonte dos defaults derivados. */
  profile: EnvironmentProfile;
}

export const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};
