import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadPlugins } from '../src/loader';

describe('loadPlugins', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-plugin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('retorna array vazio quando iacmp.json nao existe', () => {
    expect(loadPlugins(tmpDir)).toEqual([]);
  });

  test('retorna array vazio quando diretorio do projeto nao existe', () => {
    expect(loadPlugins(path.join(tmpDir, 'inexistente'))).toEqual([]);
  });

  test('lanca erro quando iacmp.json tem JSON invalido', () => {
    fs.writeFileSync(path.join(tmpDir, 'iacmp.json'), '{ invalido }');
    expect(() => loadPlugins(tmpDir)).toThrow('[iacmp] Falha ao ler');
  });

  test('retorna array vazio quando plugins esta ausente no config', () => {
    fs.writeFileSync(path.join(tmpDir, 'iacmp.json'), JSON.stringify({}));
    expect(loadPlugins(tmpDir)).toEqual([]);
  });

  test('retorna array vazio quando plugins e array vazio', () => {
    fs.writeFileSync(path.join(tmpDir, 'iacmp.json'), JSON.stringify({ plugins: [] }));
    expect(loadPlugins(tmpDir)).toEqual([]);
  });

  test('caminho feliz: carrega providers de plugin valido', () => {
    const pluginDir = path.join(tmpDir, 'node_modules', 'meu-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'index.js'),
      `module.exports = { providers: [{ name: 'test-provider', synthesize: () => ({}) }] };`,
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'meu-plugin', main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'iacmp.json'),
      JSON.stringify({ plugins: ['meu-plugin'] }),
    );

    const providers = loadPlugins(tmpDir);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('test-provider');
    expect(typeof providers[0].synthesize).toBe('function');
  });

  test('caminho feliz: acumula providers de multiplos plugins', () => {
    for (const nome of ['plugin-a', 'plugin-b']) {
      const dir = path.join(tmpDir, 'node_modules', nome);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'index.js'),
        `module.exports = { providers: [{ name: '${nome}-provider', synthesize: () => ({}) }] };`,
      );
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: nome, main: 'index.js' }),
      );
    }
    fs.writeFileSync(
      path.join(tmpDir, 'iacmp.json'),
      JSON.stringify({ plugins: ['plugin-a', 'plugin-b'] }),
    );

    const providers = loadPlugins(tmpDir);
    expect(providers).toHaveLength(2);
    expect(providers.map(p => p.name)).toEqual(['plugin-a-provider', 'plugin-b-provider']);
  });

  test('avisa e ignora plugin sem export correto (sem providers)', () => {
    const pluginDir = path.join(tmpDir, 'node_modules', 'plugin-invalido');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'index.js'),
      `module.exports = { name: 'sem-providers' };`,
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'plugin-invalido', main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'iacmp.json'),
      JSON.stringify({ plugins: ['plugin-invalido'] }),
    );

    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const providers = loadPlugins(tmpDir);
    expect(providers).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('nao exporta um IacmpPlugin valido'),
    );
    spy.mockRestore();
  });

  test('avisa e ignora provider inexistente (modulo nao encontrado)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'iacmp.json'),
      JSON.stringify({ plugins: ['modulo-que-nao-existe'] }),
    );

    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const providers = loadPlugins(tmpDir);
    expect(providers).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('nao pode ser carregado'),
    );
    spy.mockRestore();
  });

  test('suporta export default (ESM transpilado para CJS)', () => {
    const pluginDir = path.join(tmpDir, 'node_modules', 'plugin-esm');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'index.js'),
      `module.exports = { default: { providers: [{ name: 'esm-provider', synthesize: () => ({}) }] } };`,
    );
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'plugin-esm', main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'iacmp.json'),
      JSON.stringify({ plugins: ['plugin-esm'] }),
    );

    const providers = loadPlugins(tmpDir);
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('esm-provider');
  });
});
