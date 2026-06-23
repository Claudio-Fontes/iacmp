/**
 * Safety net manual: roda `npm run sweep` se um run de teste for interrompido
 * (Ctrl+C, crash) e puder ter deixado stack/snapshot reais cobrando na conta.
 * Lista e apaga:
 *  - stacks CloudFormation com prefixo "iacmp-e2e-" que não estão em
 *    CREATE_COMPLETE/UPDATE_COMPLETE recente (i.e. sobraram de um run que não
 *    terminou).
 *  - snapshots de RDS/DocumentDB com esse prefixo no identifier — necessário
 *    porque Database.SQL/DocumentDB usam DeletionPolicy: Snapshot por padrão
 *    (correto pra usuário real, mas deixa um snapshot cobrando storage depois
 *    do destroy de cada teste se não for limpo).
 */
import { execFileSync } from 'child_process';

const REGION = 'us-east-1';
const PREFIX = 'iacmp-e2e';

function aws(args: string[]): string {
  return execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf-8' });
}

function listLeftoverStacks(): string[] {
  const raw = aws(['cloudformation', 'list-stacks', '--stack-status-filter',
    'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS',
    'ROLLBACK_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE', 'DELETE_FAILED',
  ]);
  const parsed = JSON.parse(raw) as { StackSummaries: Array<{ StackName: string }> };
  return parsed.StackSummaries
    .map(s => s.StackName)
    .filter(name => name.startsWith(PREFIX));
}

function listLeftoverSnapshots(): Array<{ id: string; kind: 'rds' | 'docdb' }> {
  const rds = JSON.parse(aws(['rds', 'describe-db-snapshots', '--snapshot-type', 'manual'])) as {
    DBSnapshots: Array<{ DBSnapshotIdentifier: string }>;
  };
  const docdb = JSON.parse(aws(['docdb', 'describe-db-cluster-snapshots', '--snapshot-type', 'manual'])) as {
    DBClusterSnapshots: Array<{ DBClusterSnapshotIdentifier: string }>;
  };
  return [
    ...rds.DBSnapshots
      .filter(s => s.DBSnapshotIdentifier.startsWith(PREFIX))
      .map(s => ({ id: s.DBSnapshotIdentifier, kind: 'rds' as const })),
    ...docdb.DBClusterSnapshots
      .filter(s => s.DBClusterSnapshotIdentifier.startsWith(PREFIX))
      .map(s => ({ id: s.DBClusterSnapshotIdentifier, kind: 'docdb' as const })),
  ];
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[sweep] Procurando stacks órfãs com prefixo "${PREFIX}" em ${REGION}...`);
  const stacks = listLeftoverStacks();
  if (stacks.length === 0) {
    console.log('[sweep] Nenhuma stack órfã encontrada.');
  }
  for (const stackName of stacks) {
    console.log(`[sweep] ${dryRun ? '[dry-run] destruiria' : 'destruindo'}: ${stackName}`);
    if (!dryRun) {
      execFileSync('aws', ['cloudformation', 'delete-stack', '--stack-name', stackName, '--region', REGION]);
      execFileSync('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stackName, '--region', REGION], { stdio: 'inherit' });
    }
  }

  console.log(`[sweep] Procurando snapshots órfãos com prefixo "${PREFIX}"...`);
  const snapshots = listLeftoverSnapshots();
  if (snapshots.length === 0) {
    console.log('[sweep] Nenhum snapshot órfão encontrado.');
  }
  for (const snap of snapshots) {
    console.log(`[sweep] ${dryRun ? '[dry-run] apagaria' : 'apagando'} snapshot ${snap.kind}: ${snap.id}`);
    if (!dryRun) {
      if (snap.kind === 'rds') {
        execFileSync('aws', ['rds', 'delete-db-snapshot', '--db-snapshot-identifier', snap.id, '--region', REGION]);
      } else {
        execFileSync('aws', ['docdb', 'delete-db-cluster-snapshot', '--db-cluster-snapshot-identifier', snap.id, '--region', REGION]);
      }
    }
  }

  console.log('[sweep] Concluído.');
}

main();
