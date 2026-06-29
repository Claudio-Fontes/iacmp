import { SQLEngine } from '../constructs/database';

/**
 * Porta padrão de cada engine SQL — fato de domínio provider-agnóstico
 * (postgres é 5432 em qualquer nuvem). Fonte única de verdade consumida pela
 * validação semântica e pelos defaults dos constructs, para que esse
 * conhecimento não precise mais viver como "regra" no prompt da IA.
 */
export const SQL_ENGINE_PORTS: Record<SQLEngine, number> = {
  mysql: 3306,
  mariadb: 3306,
  'aurora-mysql': 3306,
  postgres: 5432,
  'aurora-postgresql': 5432,
  sqlserver: 1433,
  oracle: 1521,
};

export function defaultPortForEngine(engine: SQLEngine): number {
  return SQL_ENGINE_PORTS[engine];
}

export function isAuroraEngine(engine: SQLEngine): boolean {
  return engine === 'aurora-mysql' || engine === 'aurora-postgresql';
}

/**
 * RDS/Aurora exigem um DB Subnet Group cobrindo ao menos 2 Availability Zones
 * distintas. DocumentDB idem.
 */
export const RDS_MIN_AZ_COUNT = 2;
