import { Stack, BaseConstruct } from '../stack';

export interface MessagingQueueProps {
  visibilityTimeoutSeconds?: number;
  messageRetentionSeconds?: number;
  delaySeconds?: number;
  fifo?: boolean;
  dlqArn?: string;
  maxReceiveCount?: number;
  encrypted?: boolean;
}

export interface MessagingTopicProps {
  displayName?: string;
  fifo?: boolean;
  encrypted?: boolean;
  subscriptions?: Array<{
    protocol: 'lambda' | 'sqs' | 'email' | 'http' | 'https';
    endpoint: string;
  }>;
}

export namespace Messaging {
  export class Queue implements BaseConstruct {
    readonly type = 'Messaging.Queue';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: MessagingQueueProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Topic implements BaseConstruct {
    readonly type = 'Messaging.Topic';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: MessagingTopicProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
