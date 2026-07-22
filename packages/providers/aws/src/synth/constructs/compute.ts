import { BaseConstruct, isRef, type Ref } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { INSTANCE_TYPE_MAP } from '../types';
import {
  resolveSubnetId,
  resolveSecurityGroupId,
  defaultServiceRole,
  resolveTargetGroupArn,
  resolveRef,
} from '../resolvers';
import { resourceRef } from '../graph';

const AMI_MAP: Record<string, string> = {
  'ubuntu': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-22.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'ubuntu-20.04': '{{resolve:ssm:/aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}',
  'amazon-linux-2': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}',
  'amazon-linux-2023': '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}',
  'windows-2022': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base}}',
  'windows-2019': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-Base}}',
  'windows-2016': '{{resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2016-English-Full-Base}}',
};

const K8S_NODE_TYPE_MAP: Record<string, string> = {
  small: 't3.medium',
  medium: 'm5.large',
  large: 'm5.2xlarge',
};

export function synthCompute(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Compute.Instance':
      return [[logicalId, {
        Type: 'AWS::EC2::Instance',
        Properties: {
          InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
          ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
          ...(props.subnetId ? { SubnetId: resolveSubnetId(props.subnetId as string, ctx) } : {}),
          ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
        },
      }]];

    case 'Compute.AutoScaling': {
      const ltId = `${logicalId}LT`;
      const asgId = `${logicalId}ASG`;
      const spId = `${logicalId}ScalingPolicy`;

      const lt: CloudFormationResource = {
        Type: 'AWS::EC2::LaunchTemplate',
        Properties: {
          LaunchTemplateName: `${logicalId}-lt`,
          LaunchTemplateData: {
            ImageId: AMI_MAP[props.image as string] ?? (props.image as string),
            InstanceType: INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small',
            ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
          },
        },
      };

      const asg: CloudFormationResource = {
        Type: 'AWS::AutoScaling::AutoScalingGroup',
        Properties: {
          LaunchTemplate: {
            LaunchTemplateId: resourceRef(ltId, 'Id'),
            Version: resourceRef(ltId, 'LatestVersionNumber'),
          },
          MinSize: String(props.minCapacity ?? 1),
          MaxSize: String(props.maxCapacity ?? 3),
          DesiredCapacity: String(props.desiredCapacity ?? props.minCapacity ?? 1),
          ...(props.subnetIds
            ? { VPCZoneIdentifier: (props.subnetIds as string[]).map(id => resolveSubnetId(id, ctx)) }
            : { AvailabilityZones: { 'Fn::GetAZs': '' } }),
          Tags: [{ Key: 'Name', Value: logicalId, PropagateAtLaunch: true }],
        },
      };

      const entries: Array<[string, CloudFormationResource]> = [[ltId, lt], [asgId, asg]];

      if (props.targetCpuUtilization) {
        entries.push([spId, {
          Type: 'AWS::AutoScaling::ScalingPolicy',
          Properties: {
            AutoScalingGroupName: resourceRef(asgId, 'Id'),
            PolicyType: 'TargetTrackingScaling',
            TargetTrackingConfiguration: {
              PredefinedMetricSpecification: { PredefinedMetricType: 'ASGAverageCPUUtilization' },
              TargetValue: props.targetCpuUtilization,
            },
          },
        }]);
      }

      return entries;
    }

    case 'Compute.Container': {
      if (props.build) {
        throw new Error(
          `Compute.Container "${construct.id}": build de imagem ainda não suportado no provider AWS — use "image".`,
        );
      }
      const clusterLogicalId = `${logicalId}Cluster`;
      const tdLogicalId = `${logicalId}TaskDef`;
      const svcLogicalId = `${logicalId}Service`;
      const executionRoleLogicalId = `${logicalId}ExecutionRole`;
      const logGroupLogicalId = `${logicalId}LogGroup`;
      const environment = props.environment as Record<string, string | Ref> | undefined;
      const subnetIds = (props.subnetIds as string[]) ?? [];

      const entries: Array<[string, CloudFormationResource]> = [
        // Log group do awslogs: o driver do Fargate NÃO cria o grupo (a execution
        // role padrão só tem CreateLogStream/PutLogEvents, não CreateLogGroup) — sem
        // ele a task falha em "log group does not exist" e o serviço nunca estabiliza.
        [logGroupLogicalId, {
          Type: 'AWS::Logs::LogGroup',
          Properties: { LogGroupName: `/ecs/${construct.id}`, RetentionInDays: 7 },
        }],
        [clusterLogicalId, {
          Type: 'AWS::ECS::Cluster',
          Properties: { ClusterName: construct.id },
        }],
        defaultServiceRole(
          executionRoleLogicalId,
          'ecs-tasks.amazonaws.com',
          ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        ),
        [tdLogicalId, {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: construct.id,
            NetworkMode: 'awsvpc',
            RequiresCompatibilities: ['FARGATE'],
            Cpu: String(props.cpu ?? 256),
            Memory: String(props.memory ?? 512),
            ExecutionRoleArn: resourceRef(executionRoleLogicalId, 'Arn'),
            ContainerDefinitions: [{
              Name: construct.id,
              Image: props.image as string,
              PortMappings: props.port ? [{ ContainerPort: props.port, Protocol: 'tcp' }] : [],
              Environment: environment
                ? Object.entries(environment).map(([k, v]) => ({ Name: k, Value: isRef(v) ? resolveRef(v, ctx) : v }))
                : [],
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': `/ecs/${construct.id}`,
                  'awslogs-region': { Ref: 'AWS::Region' },
                  'awslogs-stream-prefix': 'ecs',
                },
              },
            }],
          },
        }],
      ];

      // Só cria o Service se subnets foram fornecidas — sem subnets o Fargate
      // falha com "subnets can not be empty" no CloudFormation.
      if (subnetIds.length > 0) {
        const hasLb = props.targetGroupArn != null;
        const serviceProps: Record<string, unknown> = {
          ServiceName: construct.id,
          Cluster: resourceRef(clusterLogicalId, 'Id'),
          TaskDefinition: resourceRef(tdLogicalId, 'Id'),
          DesiredCount: props.desiredCount ?? 1,
          LaunchType: 'FARGATE',
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: (props.publicIp as boolean) ? 'ENABLED' : 'DISABLED',
              Subnets: subnetIds.map(id => resolveSubnetId(id, ctx)),
              ...(props.securityGroupIds ? { SecurityGroups: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
            },
          },
        };
        // O Service depende do log group existir antes de iniciar as tasks.
        const serviceDependsOn: string[] = [logGroupLogicalId];
        // Registra as tasks no target group do ALB (só faz sentido com um container port).
        if (hasLb && props.port) {
          const tgArn = props.targetGroupArn as string | Ref;
          const lbId = isRef(tgArn) ? tgArn.constructId : (tgArn as string).replace(/\.TargetGroupArn$/, '');
          serviceProps.LoadBalancers = [{
            TargetGroupArn: isRef(tgArn) ? resolveRef(tgArn, ctx) : resolveTargetGroupArn(tgArn as string, ctx),
            ContainerName: construct.id,
            ContainerPort: props.port,
          }];
          // Dá tempo do container passar no health check do ALB antes do ECS matar a task.
          serviceProps.HealthCheckGracePeriodSeconds = 60;
          // O ECS exige o target group JÁ associado a um listener do ALB. Same-stack,
          // força a ordem: o Service depende do listener que faz forward pro TG
          // (não o "Listener1" cru — pode ser um redirect, ou nem existir se o único
          // listener for HTTPS-sem-cert). Cross-stack o ImportValue do TG já garante
          // que a stack do ALB subiu antes.
          const tg = ctx.albDefaultTg.get(lbId);
          if (tg && tg.stackName === ctx.currentStackName && tg.listenerLogicalId) {
            serviceDependsOn.push(tg.listenerLogicalId);
          }
        }
        entries.push([svcLogicalId, {
          Type: 'AWS::ECS::Service',
          DependsOn: serviceDependsOn,
          Properties: serviceProps,
        }]);

        // Autoscaling de tasks Fargate (ApplicationAutoScaling) — min/maxCapacity.
        if (typeof props.minCapacity === 'number' && typeof props.maxCapacity === 'number') {
          const targetLogicalId = `${logicalId}ScalableTarget`;
          entries.push([targetLogicalId, {
            Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
            DependsOn: [svcLogicalId],
            Properties: {
              MinCapacity: props.minCapacity as number,
              MaxCapacity: props.maxCapacity as number,
              // ResourceId = service/<clusterName>/<serviceName>; ambos = construct.id.
              ResourceId: `service/${construct.id}/${construct.id}`,
              ScalableDimension: 'ecs:service:DesiredCount',
              ServiceNamespace: 'ecs',
              // RoleARN omitido de propósito: o Application Auto Scaling cria/usa a
              // service-linked role sozinho. Hardcodar a SLR quebra o 1º deploy numa
              // conta que nunca usou App Auto Scaling (a SLR ainda não existe).
            },
          }]);
          entries.push([`${logicalId}ScalingPolicy`, {
            Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
            Properties: {
              PolicyName: `${construct.id}-cpu-scaling`,
              PolicyType: 'TargetTrackingScaling',
              ScalingTargetId: resourceRef(targetLogicalId, 'Id'),
              TargetTrackingScalingPolicyConfiguration: {
                PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
                TargetValue: (props.cpuTargetPercent as number) ?? 50,
              },
            },
          }]);
        }
      }

      return entries;
    }

    case 'Compute.Kubernetes': {
      const clusterRoleLogicalId = `${logicalId}ClusterRole`;
      const nodeRoleLogicalId = `${logicalId}NodeRole`;
      const subnetIds = (props.subnetIds as string[]) ?? [];
      if (subnetIds.length === 0) {
        console.warn(`[aws] Compute.Kubernetes "${construct.id}" sem subnetIds — o EKS rejeita cluster sem pelo menos 2 subnets reais em AZs diferentes.`);
      }

      return [
        defaultServiceRole(
          clusterRoleLogicalId,
          'eks.amazonaws.com',
          ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
        ),
        defaultServiceRole(
          nodeRoleLogicalId,
          'ec2.amazonaws.com',
          [
            'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
            'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
            'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
          ],
        ),
        [logicalId, {
          Type: 'AWS::EKS::Cluster',
          Properties: {
            Name: construct.id,
            Version: (props.version as string) ?? '1.29',
            ResourcesVpcConfig: {
              SubnetIds: subnetIds.map(id => resolveSubnetId(id, ctx)),
              ...(props.securityGroupIds ? { SecurityGroupIds: (props.securityGroupIds as string[]).map(id => resolveSecurityGroupId(id, ctx)) } : {}),
              EndpointPrivateAccess: (props.privateCluster as boolean) ?? false,
              EndpointPublicAccess: !(props.privateCluster as boolean),
            },
            RoleArn: resourceRef(clusterRoleLogicalId, 'Arn'),
          },
        }],
        [`${logicalId}NodeGroup`, {
          Type: 'AWS::EKS::Nodegroup',
          DependsOn: [logicalId],
          Properties: {
            ClusterName: resourceRef(logicalId, 'Id'),
            NodegroupName: `${construct.id}-ng`,
            ScalingConfig: {
              MinSize: props.minNodes ?? 1,
              MaxSize: props.maxNodes ?? 3,
              DesiredSize: props.desiredNodes ?? 2,
            },
            InstanceTypes: [K8S_NODE_TYPE_MAP[(props.nodeInstanceType as string) ?? 'medium'] ?? 'm5.large'],
            NodeRole: resourceRef(nodeRoleLogicalId, 'Arn'),
            Subnets: subnetIds.map(id => resolveSubnetId(id, ctx)),
          },
        }],
      ];
    }

    default: return null;
  }
}
