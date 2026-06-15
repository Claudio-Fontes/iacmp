import { Stack, BaseConstruct } from '../stack';

export interface WorkflowStep {
  name: string;
  type?: 'Task' | 'Choice' | 'Wait' | 'Parallel' | 'Map' | 'Pass' | 'Succeed' | 'Fail';
  resource?: string;
  description?: string;
}

export interface StepFunctionsProps {
  steps: WorkflowStep[];
  description?: string;
  type?: 'STANDARD' | 'EXPRESS';
}

export namespace Workflow {
  export class StepFunctions implements BaseConstruct {
    readonly type = 'Workflow.StepFunctions';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: StepFunctionsProps) {
      if (!props.steps || props.steps.length === 0) {
        throw new Error(`Workflow.StepFunctions "${id}": steps não pode ser vazio`);
      }
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
