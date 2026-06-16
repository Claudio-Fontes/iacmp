import * as fs from 'fs';
import * as path from 'path';
import { IacmpProvider, IacmpPlugin } from './plugin';

export function loadPlugins(projectDir: string): IacmpProvider[] {
  const configPath = path.join(projectDir, 'iacmp.json');
  if (!fs.existsSync(configPath)) {
    return [];
  }

  let config: { plugins?: string[] };
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    // iacmp.json existe mas e invalido — falhar alto e claro em vez de seguir com config vazia,
    // senao o usuario perde plugins silenciosamente e nao entende por que comandos divergem.
    throw new Error(
      `[iacmp] Falha ao ler ${configPath}: ${(err as Error).message}`,
    );
  }

  if (!config.plugins || config.plugins.length === 0) {
    return [];
  }

  const providers: IacmpProvider[] = [];

  for (const pluginName of config.plugins) {
    try {
      const pluginPath = require.resolve(pluginName, { paths: [projectDir] });
      const raw = require(pluginPath) as IacmpPlugin | { default?: IacmpPlugin };
      // Plugin pode ser exportado como `module.exports = definePlugin(...)` (CJS) ou
      // `export default definePlugin(...)` (ESM transpilado). Tratamos os dois casos.
      const mod = (raw as { default?: IacmpPlugin }).default ?? (raw as IacmpPlugin);

      if (!mod || !Array.isArray(mod.providers)) {
        console.warn(
          `[iacmp] Plugin '${pluginName}' nao exporta um IacmpPlugin valido (esperado { providers: IacmpProvider[] }).`,
        );
        continue;
      }

      providers.push(...mod.providers);
    } catch (err) {
      console.warn(`[iacmp] Plugin '${pluginName}' nao pode ser carregado: ${(err as Error).message}`);
    }
  }

  return providers;
}
