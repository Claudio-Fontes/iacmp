import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../../i18n';
import { DeployContext } from '../types';
import type { GCPContainerMeta } from '@iacmp/provider-gcp';

function collectAllContainerMeta(dir: string): GCPContainerMeta[] {
  if (!fs.existsSync(dir)) return [];
  const out: GCPContainerMeta[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.iacmp-meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as { containers?: GCPContainerMeta[] };
      out.push(...(meta.containers ?? []));
    } catch {
      /* meta ilegível — synth de novo resolve */
    }
  }
  return out;
}

/**
 * Builda e faz push das imagens de Compute.Container que usaram `build` via
 * `gcloud builds submit`. Retorna o imageName → URI real mapeado para o patch.
 * Pulado em --dry-run.
 */
export function buildAndPushContainers(ctx: DeployContext, projectId: string, dir: string): Map<string, string> {
  const containers = collectAllContainerMeta(dir);
  const imageByName = new Map<string, string>();
  for (const c of containers) {
    const tag = `gcr.io/${projectId}/${c.imageName}:latest`;
    const context = path.resolve(ctx.cwd, c.context);
    const args = ['builds', 'submit', '--tag', tag, '--project', projectId];
    if (c.dockerfile) {
      args.push('--config', path.resolve(context, c.dockerfile));
    }
    args.push(context);
    process.stdout.write(t(`[iacmp] Buildando imagem ${tag}...\n`, `[iacmp] Building image ${tag}...\n`));
    execFileSync('gcloud', args, { stdio: 'inherit', cwd: ctx.cwd });
    imageByName.set(c.imageName, tag);
  }
  return imageByName;
}

/** Substitui o placeholder `gcr.io/IACMP_BUILD_PLACEHOLDER/<imageName>:latest` pela URI real em todos os tf.json do diretório de synth GCP. */
export function patchContainerImages(dir: string, imageByName: Map<string, string>): void {
  if (imageByName.size === 0) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tf.json')) continue;
    const filePath = path.join(dir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    let changed = false;
    for (const [imageName, realUri] of imageByName) {
      const placeholder = `gcr.io/IACMP_BUILD_PLACEHOLDER/${imageName}:latest`;
      if (content.includes(placeholder)) {
        content = content.split(placeholder).join(realUri);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, content);
    }
  }
}
