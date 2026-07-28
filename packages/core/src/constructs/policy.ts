import { type Ref } from '../refs';
import { Stack, BaseConstruct } from '../stack';

// (string & {}) mantém o autocomplete das literais mas aceita `string` inferido —
// a IA monta statements em arrays intermediários e o TS alarga 'Allow' p/ string,
// travando o loop de correção (ciclo p01az5). O synth valida o valor em runtime.
export type PolicyEffect = 'Allow' | 'Deny' | (string & {});
export type PolicyPrincipalType = 'service' | 'account' | 'role' | 'user' | 'any';

export interface PolicyStatement {
  effect: PolicyEffect;
  actions: string[];
  resources?: Array<string | Ref>;
  conditions?: Record<string, Record<string, string>>;
}

export interface PolicyProps {
  attachTo: string;
  attachType: 'lambda' | 'compute' | 'bucket' | 'database' | 'role' | 'group';
  statements: PolicyStatement[];
  description?: string;
}

export namespace Policy {
  export class IAM implements BaseConstruct {
    readonly type = 'Policy.IAM';
    readonly props: Record<string, unknown>;

    constructor(stack: Stack, readonly id: string, props: PolicyProps) {
      if (!props.attachTo) throw new Error(`Policy.IAM "${id}": attachTo é obrigatório`);
      if (!props.statements || props.statements.length === 0) {
        throw new Error(`Policy.IAM "${id}": statements não pode ser vazio`);
      }
      for (const stmt of props.statements) {
        if (!stmt.actions || stmt.actions.length === 0) {
          throw new Error(`Policy.IAM "${id}": cada statement precisa de pelo menos uma action`);
        }
      }
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
