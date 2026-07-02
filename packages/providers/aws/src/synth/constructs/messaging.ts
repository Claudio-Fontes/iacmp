import { BaseConstruct, isRef } from '@iacmp/core';
import type { CloudFormationResource, SynthContext } from '../types';
import { resolveLambdaArnRef, resolveRef, normalizeRate, resolveQueueArn } from '../resolvers';

export function synthMessaging(
  construct: BaseConstruct,
  ctx: SynthContext,
): Array<[string, CloudFormationResource]> | null {
  const props = construct.props as Record<string, unknown>;
  const logicalId = construct.id.replace(/[^a-zA-Z0-9]/g, '');
  switch (construct.type) {
    case 'Messaging.Stream': {
      return [[logicalId, {
        Type: 'AWS::Kinesis::Stream',
        Properties: {
          Name: construct.id,
          ShardCount: (props.shards as number) ?? 1,
          RetentionPeriodHours: (props.retentionHours as number) ?? 24,
          ...(props.encrypted ? { StreamEncryption: { EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' } } : {}),
        },
      }]];
    }

    case 'Messaging.Queue': {
      const fifo = (props.fifo as boolean) ?? false;
      return [[logicalId, {
        Type: 'AWS::SQS::Queue',
        Properties: {
          QueueName: fifo ? `${construct.id}.fifo` : construct.id,
          VisibilityTimeout: (props.visibilityTimeoutSeconds as number) ?? 30,
          MessageRetentionPeriod: (props.messageRetentionSeconds as number) ?? 345600,
          DelaySeconds: (props.delaySeconds as number) ?? 0,
          ...(fifo ? { FifoQueue: true } : {}),
          SqsManagedSseEnabled: (props.encrypted as boolean) ?? true,
          ...(props.dlqArn ? { RedrivePolicy: { deadLetterTargetArn: resolveQueueArn(props.dlqArn as string, ctx), maxReceiveCount: (props.maxReceiveCount as number) ?? 3 } } : {}),
        },
      }]];
    }

    case 'Messaging.Topic': {
      const fifo = (props.fifo as boolean) ?? false;
      const subscriptions = (props.subscriptions as Array<Record<string, unknown>>) ?? [];
      const topicEntries: Array<[string, CloudFormationResource]> = [[logicalId, {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: fifo ? `${construct.id}.fifo` : construct.id,
          DisplayName: (props.displayName as string) ?? construct.id,
          ...(fifo ? { FifoTopic: true } : {}),
          ...(props.encrypted ? { KmsMasterKeyId: 'alias/aws/sns' } : {}),
        },
      }]];

      // Cada subscription vira um AWS::SNS::Subscription. Para SQS, resolve o
      // ARN da fila (por id de construct), aplica filterPolicy e cria a
      // SQS::QueuePolicy que autoriza o SNS a publicar na fila (fan-out).
      const subscribedQueues: string[] = [];
      subscriptions.forEach((s, i) => {
        const protocol = s.protocol as string;
        const endpointVal = s.endpoint;
        const endpointRaw = isRef(endpointVal) ? endpointVal.constructId : (endpointVal as string);
        // sqs/lambda: endpoint pode ser id de construct ou Ref → resolve ARN.
        const isConstructId = (protocol === 'sqs' || protocol === 'lambda') && ctx.registry.has(endpointRaw);
        if (protocol === 'lambda' && isConstructId && ctx.registry.get(endpointRaw)?.type !== 'Function.Lambda') {
          throw new Error(`Messaging.Topic "${construct.id}": subscription[${i}] protocol:'lambda' tem endpoint "${endpointRaw}", que não é uma Fn.Lambda. Aponte para o id de uma Function.Lambda.`);
        }
        const endpoint = isRef(endpointVal)
          ? resolveRef(endpointVal, ctx)
          : isConstructId
            ? (protocol === 'sqs' ? resolveQueueArn(endpointRaw, ctx) : resolveLambdaArnRef(endpointRaw, ctx))
            : endpointRaw;
        const subId = `${logicalId}Sub${i + 1}`;
        topicEntries.push([subId, {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            TopicArn: { Ref: logicalId },
            Protocol: protocol,
            Endpoint: endpoint,
            ...(protocol === 'sqs' ? { RawMessageDelivery: true } : {}),
            ...(s.filterPolicy ? { FilterPolicy: s.filterPolicy } : {}),
          },
        }]);
        if (protocol === 'sqs' && isConstructId) subscribedQueues.push(endpointRaw);
        // SNS → Lambda: a Subscription só entrega se a Lambda autorizar o SNS a
        // invocá-la. Sem essa permission a assinatura não confirma / não dispara.
        if (protocol === 'lambda' && isConstructId) {
          topicEntries.push([`${logicalId}InvokeLambda${i + 1}`, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: endpoint,
              Principal: 'sns.amazonaws.com',
              SourceArn: { Ref: logicalId },
            },
          }]);
        }
      });

      // SQS::QueuePolicy: autoriza o SNS a enviar mensagens para cada fila inscrita.
      subscribedQueues.forEach(qId => {
        const qLogical = qId.replace(/[^a-zA-Z0-9]/g, '');
        topicEntries.push([`${qLogical}SnsPolicy`, {
          Type: 'AWS::SQS::QueuePolicy',
          Properties: {
            Queues: [{ Ref: qLogical }],
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Principal: { Service: 'sns.amazonaws.com' },
                Action: 'sqs:SendMessage',
                Resource: resolveQueueArn(qId, ctx),
                Condition: { ArnEquals: { 'aws:SourceArn': { Ref: logicalId } } },
              }],
            },
          },
        }]);
      });

      return topicEntries;
    }

    case 'Events.EventBridge': {
      const rules = (props.rules as Array<Record<string, unknown>>) ?? [];
      const busName = (props.busName as string) ?? 'default';
      const entries: Array<[string, CloudFormationResource]> = [];

      if (busName !== 'default') {
        entries.push([`${logicalId}Bus`, { Type: 'AWS::Events::EventBus', Properties: { Name: busName } }]);
      }

      for (const r of rules) {
        const ruleName = ((r.name as string) ?? 'rule').replace(/[^a-zA-Z0-9]/g, '');
        const ruleLogicalId = `${logicalId}${ruleName}Rule`;
        const pattern: Record<string, unknown> = {};
        if (r.source) pattern['source'] = r.source;
        if (r.detailTypes) pattern['detail-type'] = r.detailTypes;

        // Agendamento: cron('...') ou rate('...'). CloudFormation exige o wrapper.
        const scheduleExpression = r.cron
          ? `cron(${r.cron})`
          : r.rate
          ? `rate(${normalizeRate(r.rate as string)})`
          : undefined;

        // Target: resolve targetLambdaId (ou targetArn com id) → ARN da Lambda.
        const targetLambdaId = (r.targetLambdaId as string | undefined)
          ?? (typeof r.targetArn === 'string' && ctx.registry.has(r.targetArn) ? (r.targetArn as string) : undefined);
        if (targetLambdaId && ctx.registry.get(targetLambdaId)?.type !== 'Function.Lambda') {
          throw new Error(`Events.EventBridge "${construct.id}": targetLambdaId "${targetLambdaId}" não é uma Fn.Lambda. Aponte para o id de uma Function.Lambda.`);
        }
        const targetArnValue = targetLambdaId
          ? resolveLambdaArnRef(targetLambdaId, ctx)
          : (r.targetArn as string | undefined);

        const eventBusName = busName !== 'default' ? { Ref: `${logicalId}Bus` } : 'default';

        entries.push([ruleLogicalId, {
          Type: 'AWS::Events::Rule',
          Properties: {
            Name: r.name as string,
            // ScheduleExpression e EventBusName custom são mutuamente exclusivos
            // com EventPattern só quando faz sentido: agendada não usa pattern.
            ...(scheduleExpression ? { ScheduleExpression: scheduleExpression } : { EventBusName: eventBusName, EventPattern: pattern }),
            State: 'ENABLED',
            ...(targetArnValue ? { Targets: [{ Id: `${ruleName}Target`, Arn: targetArnValue }] } : {}),
          },
        }]);

        // Permissão para o EventBridge invocar a Lambda alvo.
        if (targetLambdaId) {
          entries.push([`${ruleLogicalId}Permission`, {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              Action: 'lambda:InvokeFunction',
              FunctionName: resolveLambdaArnRef(targetLambdaId, ctx),
              Principal: 'events.amazonaws.com',
              SourceArn: { 'Fn::GetAtt': [ruleLogicalId, 'Arn'] },
            },
          }]);
        }
      }

      return entries;
    }

    default: return null;
  }
}
