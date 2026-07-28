import { Stack } from '@iacmp/core';

export interface IacmpProvider {
  name: string;
  synthesize(stack: Stack): unknown;
  deploy?(stack: Stack): Promise<void>;
  destroy?(stack: Stack): Promise<void>;
}

export interface IacmpPlugin {
  providers: IacmpProvider[];
}

export function definePlugin(plugin: IacmpPlugin): IacmpPlugin {
  return plugin;
}
