import * as path from 'path';
import * as fs from 'fs';

export interface RegistryConstruct {
  name: string;
  package: string;
  description: string;
  providers: string[];
  version: string;
  author: string;
}

export interface Registry {
  version: string;
  constructs: RegistryConstruct[];
}

function loadRegistry(): Registry {
  const registryPath = path.join(__dirname, 'registry.json');
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
}

export function listConstructs(): RegistryConstruct[] {
  return loadRegistry().constructs;
}

export function searchConstructs(term: string): RegistryConstruct[] {
  const lower = term.toLowerCase();
  return loadRegistry().constructs.filter(c =>
    c.name.toLowerCase().includes(lower) ||
    c.description.toLowerCase().includes(lower) ||
    c.package.toLowerCase().includes(lower),
  );
}
