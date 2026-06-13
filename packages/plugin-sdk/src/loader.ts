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
  } catch {
    return [];
  }

  if (!config.plugins || config.plugins.length === 0) {
    return [];
  }

  const providers: IacmpProvider[] = [];

  for (const pluginName of config.plugins) {
    try {
      const pluginPath = require.resolve(pluginName, { paths: [projectDir] });
      const pluginModule = require(pluginPath) as IacmpPlugin;

      if (pluginModule && Array.isArray(pluginModule.providers)) {
        providers.push(...pluginModule.providers);
      } else {
        console.warn(`[iacmp] Plugin '${pluginName}' não exporta providers válidos.`);
      }
    } catch (err) {
      console.warn(`[iacmp] Plugin '${pluginName}' não pôde ser carregado: ${(err as Error).message}`);
    }
  }

  return providers;
}
