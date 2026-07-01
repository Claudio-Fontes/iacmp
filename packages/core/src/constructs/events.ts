import { Stack, BaseConstruct } from '../stack';

export interface EventBridgeRule {
  name: string;
  source?: string[];
  detailTypes?: string[];
  /** Agendamento cron (ex: '0 8 * * ? *') OU rate (ex: '1 hour', '5 minutes'). Um dos dois para rule agendada. */
  cron?: string;
  rate?: string;
  /** Alvo da rule: id de um Fn.Lambda (o synth resolve o ARN e cria a permissão) ou ARN literal. */
  targetLambdaId?: string;
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
