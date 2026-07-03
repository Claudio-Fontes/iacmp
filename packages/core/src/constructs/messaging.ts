import { ref, type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

export interface QueueRefs {
  readonly arn: Ref<'Arn'>;
  readonly queueUrl: Ref<'QueueUrl'>;
}

export interface TopicRefs {
  readonly arn: Ref<'Arn'>;
}

export interface StreamRefs {
  readonly arn: Ref<'Arn'>;
  readonly name: Ref<'Name'>;
}

export interface MessagingQueueProps {
  visibilityTimeoutSeconds?: number;
  messageRetentionSeconds?: number;
  delaySeconds?: number;
  fifo?: boolean;
  dlqArn?: string | Ref<'Arn'>;
  maxReceiveCount?: number;
  encrypted?: boolean;
}

export interface MessagingTopicProps {
  displayName?: string;
  fifo?: boolean;
  encrypted?: boolean;
  subscriptions?: Array<{
    protocol: 'lambda' | 'sqs' | 'email' | 'http' | 'https';
    /** Endpoint do subscriber. Para 'sqs'/'lambda', pode ser o id de um construct
     *  (Messaging.Queue/Fn.Lambda) — o synth resolve o ARN. Para email/http, o valor literal. */
    endpoint: string | Ref;
    /** Filtro de mensagens por atributo (SNS message filtering). */
    filterPolicy?: Record<string, unknown>;
  }>;
}

export interface MessagingStreamProps {
  /** Número de shards (paralelismo/throughput). Default 1. */
  shards?: number;
  /** Retenção dos registros em horas (24–8760). Default 24. */
  retentionHours?: number;
  encrypted?: boolean;
}

export namespace Messaging {
  export class Queue implements BaseConstruct, QueueRefs {
    readonly type = 'Messaging.Queue';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: MessagingQueueProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get arn(): Ref<'Arn'> { return ref(this.id, 'Arn'); }
    get queueUrl(): Ref<'QueueUrl'> { return ref(this.id, 'QueueUrl'); }
  }

  /** Kinesis Data Stream — ingestão de eventos em tempo real. */
  export class Stream implements BaseConstruct, StreamRefs {
    readonly type = 'Messaging.Stream';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: MessagingStreamProps = {}) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get arn(): Ref<'Arn'> { return ref(this.id, 'Arn'); }
    get name(): Ref<'Name'> { return ref(this.id, 'Name'); }
  }

  export class Topic implements BaseConstruct, TopicRefs {
    readonly type = 'Messaging.Topic';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: MessagingTopicProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
    get arn(): Ref<'Arn'> { return ref(this.id, 'Arn'); }
  }
}
