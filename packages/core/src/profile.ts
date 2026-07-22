/**
 * Perfil de ambiente — contexto provider-agnóstico lido do iacmp.json. Permite
 * que os defaults de infraestrutura (retenção de backup, criptografia, AZs)
 * sejam DERIVADOS do tipo de conta em vez de hardcoded no .ts ou no prompt da
 * IA. Trocar de conta free para standard passa a ser uma mudança de
 * configuração, não de código.
 */
export type AccountTier = 'free' | 'standard';

export interface EnvironmentProfile {
  accountTier: AccountTier;
  region?: string;
  /** Região de DR (AWS) — resolve stacks region:'dr' e origens cross-região do CDN. */
  drRegion?: string;
  /** AZs explícitas da região, quando o usuário quer fixá-las. */
  availabilityZones?: string[];
  /** Cloud de destino — usado pelo validador agnóstico para suprimir regras AWS-only. */
  cloud?: 'aws' | 'azure' | 'gcp';
}

/** Conta free é o default seguro quando o iacmp.json não informa o tier. */
export const DEFAULT_PROFILE: EnvironmentProfile = { accountTier: 'free' };

export interface DatabaseDefaults {
  backupRetentionDays: number;
  storageEncrypted: boolean;
}

/**
 * Defaults de banco por tier. Free tier AWS não suporta retenção de backup > 0
 * nem criptografia de storage em RDS — por isso o default free é 0/false. Conta
 * standard ganha defaults de produção.
 */
export function databaseDefaultsForTier(tier: AccountTier): DatabaseDefaults {
  return tier === 'standard'
    ? { backupRetentionDays: 7, storageEncrypted: true }
    : { backupRetentionDays: 0, storageEncrypted: false };
}
