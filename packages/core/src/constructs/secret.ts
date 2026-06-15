import { Stack, BaseConstruct } from '../stack';

export interface SecretVaultProps {
  description?: string;
  kmsKeyId?: string;
  rotationDays?: number;
  replicaRegions?: string[];
}

export interface CertificateTLSProps {
  domainName: string;
  subjectAlternativeNames?: string[];
  validationMethod?: 'DNS' | 'EMAIL';
  region?: string;
}

export namespace Secret {
  export class Vault implements BaseConstruct {
    readonly type = 'Secret.Vault';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: SecretVaultProps) {
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}

export namespace Certificate {
  export class TLS implements BaseConstruct {
    readonly type = 'Certificate.TLS';
    readonly props: Record<string, unknown>;
    constructor(stack: Stack, readonly id: string, props: CertificateTLSProps) {
      if (!props.domainName)
        throw new Error(`Certificate.TLS "${id}": domainName é obrigatório`);
      this.props = props as unknown as Record<string, unknown>;
      stack.addConstruct(this);
    }
  }
}
