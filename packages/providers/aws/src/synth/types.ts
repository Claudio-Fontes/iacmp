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
  /**
   * Nome do projeto (iacmp.json), quando o synth roda via CLI. Prefixa NOMES
   * FÍSICOS de recursos (FunctionName, TableName, DBClusterIdentifier) para
   * que dois projetos na mesma conta não colidam — mesma regra do StackName.
   * Ausente em testes isolados → nomes sem prefixo (comportamento antigo).
   */
  projectName?: string;
  /** constructId → { stackName, type } de TODAS as stacks do universo. */
  registry: Map<string, { stackName: string; type: string }>;
  /**
   * lambdaId (id de uma Function.Lambda) → role IAM criada por um Policy.IAM
   * (attachType: 'lambda', attachTo: lambdaId) que a referencia, se existir.
   */
  lambdaRoles: Map<string, { stackName: string; roleLogicalId: string }>;
  /** constructId de Database → sufixo do nome do secret (ex: 'AppDB' → 'db-password' ou 'aurora-password'). */
  dbSecretSuffix: Map<string, string>;
  /** constructId de Database.SQL/DocumentDB → masterUsername real usado no recurso. */
  dbMasterUsername: Map<string, string>;
  /** IDs de Fn.Lambda com eventSources SQS — a role precisa da SQSQueueExecutionRole. */
  sqsEventSourceLambdas: Set<string>;
  /** IDs de Fn.Lambda com eventSources Kinesis — a role precisa da KinesisExecutionRole. */
  kinesisEventSourceLambdas: Set<string>;
  /** IDs de Function.Lambda que têm vpcId definido — precisam de VPCAccessExecutionRole. */
  vpcLambdas: Set<string>;
  /** constructId de Network.LoadBalancer → target group default (1º) e o listener que
   *  faz forward pra ele (para o ECS Service depender do listener certo). */
  albDefaultTg: Map<string, { stackName: string; tgLogicalId: string; listenerLogicalId?: string }>;
  /** vpcId (construct id) → Network.Subnet com public:true que o referenciam (para IGW + rota pública). */
  publicSubnetsByVpc: Map<string, Array<{ id: string; stackName: string }>>;
  /** Perfil de ambiente (tier da conta, região) — fonte dos defaults derivados. */
  profile: EnvironmentProfile;
  /**
   * lambdaId → Set de bucketIds (Storage.Bucket) que estão na mesma stack e têm
   * eventNotifications apontando para essa Lambda. Usado para quebrar o ciclo
   * CloudFormation Bucket→Permission→Lambda→PolicyRole→Bucket: quando a política
   * IAM de uma Lambda referencia o ARN de um bucket que a dispara (mesma stack),
   * o synth substitui o ARN pelo wildcard '*' (sem dependência CloudFormation).
   */
  s3TriggerBucketsForLambda: Map<string, Set<string>>;
  /**
   * IDs de Function.Lambda que têm uma ref a Workflow.StepFunctions no
   * environment (ex: STATE_MACHINE_ARN: ref('X','Arn')). Quando não há
   * Policy.IAM explícito, a default role recebe inline policy
   * states:StartExecution — sem isso o runtime falha com AccessDeniedException.
   */
  sfnInitiatorLambdas: Set<string>;
  /**
   * lambdaId → Set de constructIds de Database.DynamoDB referenciados no
   * environment. Quando não há Policy.IAM explícito, a default role recebe
   * inline policy com as ações CRUD básicas do DynamoDB.
   */
  dynamoRefLambdas: Map<string, Set<string>>;
  /**
   * lambdaId → Set de constructIds de Messaging.Queue (SQS) referenciados no
   * environment (ex: QUEUE_URL). Quando não há Policy.IAM explícito, a default
   * role recebe inline policy sqs:SendMessage — sem isso AccessDeniedException.
   */
  sqsSenderRefLambdas: Map<string, Set<string>>;
}

export const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};

/**
 * Nome FÍSICO de um recurso: prefixado com o nome do projeto quando presente
 * (synth real), para que dois projetos na mesma conta AWS nunca colidam —
 * ex: Lambda "Api" do p08 e do p09 viram "p08-Api" e "p09-Api". Sem projectName
 * (testes isolados), retorna o id cru — comportamento idêntico ao anterior.
 * `maxLen` respeita o limite do serviço (Lambda 64, RDS identifier 63).
 */
export function physicalName(ctx: SynthContext, id: string, maxLen = 64): string {
  const name = ctx.projectName ? `${ctx.projectName}-${id}` : id;
  return name.slice(0, maxLen);
}
