import { execFileSync } from 'child_process';
import * as fs from 'fs';
import chalk from 'chalk';
import { t } from '../../i18n';
import { errMessage } from '../../utils';
import { listApimServices, purgeApimSoftDeleted } from '../azure';
import { confirm, DeployUI } from './common';

/**
 * Limpezas pós-destroy que os deployers nativos não cobrem: cascas e órfãos
 * que sobrevivem por design (RG vazio, buckets Retain, APIM soft-deleted).
 * Toda remoção destrutiva exige confirmação (ou --force); sem TTY só avisa.
 */

// Após o destroy Azure, o resource group (o container) sobrevive como casca
// vazia. Oferece removê-lo — mas SÓ se estiver realmente VAZIO e com CONFIRMAÇÃO
// (um RG pode ser compartilhado; nunca apagamos às cegas). Sem TTY e sem --force,
// não apaga: só avisa como remover manualmente.
export async function maybeDeleteEmptyRg(rg: string, force: boolean, ui: DeployUI): Promise<void> {
  let count: number;
  try {
    const out = execFileSync('az', ['resource', 'list', '--resource-group', rg, '--query', 'length(@)', '-o', 'tsv'], { stdio: 'pipe' }).toString().trim();
    count = parseInt(out, 10);
  } catch {
    return; // RG já não existe, ou az indisponível → nada a fazer
  }
  if (!Number.isFinite(count)) return;
  if (count > 0) {
    ui.log(chalk.dim(t(
      `Resource group "${rg}" ainda tem ${count} recurso(s) — mantido (não é uma casca vazia).`,
      `Resource group "${rg}" still has ${count} resource(s) — kept (it is not an empty shell).`,
    )));
    return;
  }
  let ok = force;
  if (!force) {
    if (!process.stdin.isTTY) {
      ui.log(chalk.dim(t(
        `Resource group "${rg}" ficou vazio. Para remover: az group delete --name ${rg} --yes`,
        `Resource group "${rg}" is now empty. To remove it: az group delete --name ${rg} --yes`,
      )));
      return;
    }
    ok = await confirm(t(
      `O resource group "${rg}" ficou vazio. Excluir também?`,
      `Resource group "${rg}" is now empty. Delete it as well?`,
    ));
  }
  if (!ok) return;
  ui.log(t(`Removendo resource group "${rg}"...`, `Removing resource group "${rg}"...`));
  try {
    execFileSync('az', ['group', 'delete', '--name', rg, '--yes'], { stdio: 'inherit' });
  } catch (err) {
    ui.log(chalk.dim(t(
      `Não consegui remover o RG (${errMessage(err)}) — remova manualmente se quiser.`,
      `Could not remove the RG (${errMessage(err)}) — remove it manually if you want.`,
    )));
  }
}

// Buckets com DeletionPolicy Retain sobrevivem ao destroy (por design — protegem
// dados). Ficam órfãos e todo destroy os deixa para trás. Oferece esvaziar +
// remover os buckets DO PROJETO (só os declarados nos templates, com BucketName
// explícito) que ainda existem — com CONFIRMAÇÃO (apaga dados permanentemente).
// Sem TTY e sem --force: só avisa como remover manualmente.
export async function maybePurgeRetainedBuckets(templatePaths: string[], region: string, force: boolean, ui: DeployUI): Promise<void> {
  const buckets = new Set<string>();
  for (const p of templatePaths) {
    let tpl: { Resources?: Record<string, { Type?: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }> };
    try { tpl = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { continue; }
    for (const res of Object.values(tpl.Resources ?? {})) {
      if (res.Type !== 'AWS::S3::Bucket' || res.DeletionPolicy !== 'Retain') continue;
      const name = res.Properties?.BucketName;
      if (typeof name === 'string') buckets.add(name);
    }
  }
  const alive = [...buckets].filter(b => {
    try { execFileSync('aws', ['s3api', 'head-bucket', '--bucket', b], { stdio: 'pipe' }); return true; }
    catch { return false; }
  });
  if (alive.length === 0) return;

  ui.log(chalk.yellow(t(
    `\nBucket(s) com DeletionPolicy Retain que sobreviveram ao destroy: ${alive.join(', ')}`,
    `\nBucket(s) with DeletionPolicy Retain that survived the destroy: ${alive.join(', ')}`,
  )));
  let ok = force;
  if (!force) {
    if (!process.stdin.isTTY) {
      ui.log(chalk.dim(t(
        `Para remover cada um: esvazie as versões e rode 'aws s3api delete-bucket --bucket <nome>'.`,
        `To remove each one: empty the versions and run 'aws s3api delete-bucket --bucket <name>'.`,
      )));
      return;
    }
    ok = await confirm(t(
      `Esvaziar (INCLUINDO versões) e EXCLUIR esse(s) bucket(s)? APAGA os dados permanentemente`,
      `Empty (INCLUDING versions) and DELETE these bucket(s)? This permanently ERASES the data`,
    ));
  }
  if (!ok) return;
  for (const b of alive) {
    ui.log(t(`Esvaziando e removendo s3://${b}...`, `Emptying and removing s3://${b}...`));
    try {
      emptyBucket(b);
      execFileSync('aws', ['s3api', 'delete-bucket', '--bucket', b, '--region', region], { stdio: 'pipe' });
    } catch (err) {
      ui.log(chalk.dim(t(
        `Falha em ${b} (${errMessage(err)}) — remova manualmente.`,
        `Failed on ${b} (${errMessage(err)}) — remove it manually.`,
      )));
    }
  }
}

// Esvazia um bucket S3 por completo: objetos correntes + TODAS as versões e
// delete-markers (um bucket versionado não deixa `delete-bucket` sem isso).
function emptyBucket(bucket: string): void {
  try { execFileSync('aws', ['s3', 'rm', `s3://${bucket}`, '--recursive'], { stdio: 'pipe' }); } catch { /* já vazio de correntes */ }
  for (const kind of ['Versions', 'DeleteMarkers']) {
    for (let i = 0; i < 500; i++) {
      const out = execFileSync('aws', ['s3api', 'list-object-versions', '--bucket', bucket,
        '--query', `${kind}[].{Key:Key,VersionId:VersionId}`, '--max-items', '900', '--output', 'json'], { stdio: 'pipe' }).toString();
      const objs = JSON.parse(out) as { Key: string; VersionId: string }[] | null;
      if (!objs || objs.length === 0) break;
      execFileSync('aws', ['s3api', 'delete-objects', '--bucket', bucket,
        '--delete', JSON.stringify({ Objects: objs, Quiet: true })], { stdio: 'pipe' });
    }
  }
}

// APIM vai pra soft-delete (48h) no destroy: ocupa o nome (re-deploy colide)
// e a quota. Captura os vivos ANTES do delete para purgar depois em background.
export function captureApimsToPurge(resourceGroup: string): ReturnType<typeof listApimServices> {
  return listApimServices(resourceGroup);
}

export function fireApimPurge(apims: ReturnType<typeof listApimServices>, ui: DeployUI): void {
  if (apims.length === 0) return;
  purgeApimSoftDeleted(apims);
  ui.log(chalk.dim(t(
    `Purga do APIM soft-deleted disparada em background: ${apims.map(a => a.name).join(', ')} ` +
    `(libera o nome para re-deploy — sem isso ficaria 48h na lixeira do Azure).`,
    `Purge of soft-deleted APIM fired in background: ${apims.map(a => a.name).join(', ')} ` +
    `(frees the name for re-deploy — without this it would sit 48h in the Azure recycle bin).`,
  )));
}
