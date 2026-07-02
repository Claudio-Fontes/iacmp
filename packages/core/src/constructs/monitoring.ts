import { type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

export interface MonitoringAlarmProps {
  metricName: string;
  namespace?: string;
  threshold: number;
  evaluationPeriods?: number;
  periodSeconds?: number;
  comparisonOperator?: 'GreaterThanThreshold' | 'LessThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold';
  statistic?: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount';
  treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing';
  alarmActions?: Array<string | Ref>;
  okActions?: Array<string | Ref>;
  dimensions?: Record<string, string>;
}

export interface MonitoringDashboardWidget {
  type: 'metric' | 'text' | 'alarm';
  title: string;
  metricName?: string;
  namespace?: string;
  dimensions?: Record<string, string>;
  period?: number;
  stat?: string;
  markdown?: string;
}

export interface MonitoringDashboardProps {
  widgets: MonitoringDashboardWidget[];
}

export interface LoggingStreamProps {
  retentionDays?: 1 | 3 | 5 | 7 | 14 | 30 | 60 | 90 | 120 | 150 | 180 | 365 | 400 | 545 | 731 | 1096 | 1827 | 2192 | 2557 | 2922 | 3288 | 3653;
  kmsKeyId?: string;
  subscriptionFilters?: Array<{
    name: string;
    filterPattern: string;
    destinationArn: string;
  }>;
}

export namespace Monitoring {
  export class Alarm implements BaseConstruct {
    readonly type = 'Monitoring.Alarm';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: MonitoringAlarmProps) {
      if (!props.metricName)
        throw new Error(`Monitoring.Alarm "${id}": metricName é obrigatório`);
      if (props.threshold === undefined)
        throw new Error(`Monitoring.Alarm "${id}": threshold é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }

  export class Dashboard implements BaseConstruct {
    readonly type = 'Monitoring.Dashboard';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: MonitoringDashboardProps) {
      if (!props.widgets || props.widgets.length === 0)
        throw new Error(`Monitoring.Dashboard "${id}": widgets não pode ser vazio`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}

export namespace Logging {
  export class Stream implements BaseConstruct {
    readonly type = 'Logging.Stream';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: LoggingStreamProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
