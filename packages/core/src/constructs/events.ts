import { Stack, BaseConstruct } from '../stack';

export interface EventBridgeRule {
  name: string;
  source?: string[];
  detailTypes?: string[];
  targetArn?: string;
  description?: string;
}

export interface EventBridgeProps {
  busName?: string;
  rules?: EventBridgeRule[];
  description?: string;
}

export namespace Events {
  export class EventBridge implements BaseConstruct {
    readonly type = 'Events.EventBridge';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: EventBridgeProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
