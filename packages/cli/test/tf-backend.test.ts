import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyTfBackend, warnIfLocalState } from '../src/deploy/tf-backend';

/** State remoto com locking (auditoria P1-04) — configuração e validação. */
describe('applyTfBackend', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-tfb-')); });
  const backendFile = () => path.join(dir, '_backend.tf.json');

  it('sem configuração: não escreve backend (state local, comportamento default)', () => {
    expect(applyTfBackend(dir, undefined)).toBe(false);
    expect(fs.existsSync(backendFile())).toBe(false);
  });

  it('s3: gera o bloco terraform.backend com os campos passados', () => {
    const ok = applyTfBackend(dir, { type: 's3', bucket: 'meu-state', key: 'prod/app.tfstate', region: 'us-east-1', dynamodb_table: 'locks' });
    expect(ok).toBe(true);
    const doc = JSON.parse(fs.readFileSync(backendFile(), 'utf-8'));
    expect(doc.terraform[0].backend[0].s3).toEqual({
      bucket: 'meu-state', key: 'prod/app.tfstate', region: 'us-east-1', dynamodb_table: 'locks',
    });
  });

  it('gcs e azurerm também são suportados', () => {
    applyTfBackend(dir, { type: 'gcs', bucket: 'b', prefix: 'p' });
    expect(JSON.parse(fs.readFileSync(backendFile(), 'utf-8')).terraform[0].backend[0].gcs).toEqual({ bucket: 'b', prefix: 'p' });
    applyTfBackend(dir, { type: 'azurerm', resourceGroupName: 'rg', storageAccountName: 'st', containerName: 'c', key: 'k' });
    expect(JSON.parse(fs.readFileSync(backendFile(), 'utf-8')).terraform[0].backend[0].azurerm.containerName).toBe('c');
  });

  it('falha listando os campos que faltam', () => {
    expect(() => applyTfBackend(dir, { type: 's3', bucket: 'b' })).toThrow(/key, region/);
    expect(() => applyTfBackend(dir, { type: 'azurerm', key: 'k' })).toThrow(/resourceGroupName/);
  });

  it('falha em tipo desconhecido', () => {
    expect(() => applyTfBackend(dir, { type: 'consul' } as never)).toThrow(/não suportado|not supported/);
  });

  it('remover a config apaga o arquivo (não fica backend órfão de execução anterior)', () => {
    applyTfBackend(dir, { type: 'gcs', bucket: 'b' });
    expect(fs.existsSync(backendFile())).toBe(true);
    expect(applyTfBackend(dir, undefined)).toBe(false);
    expect(fs.existsSync(backendFile())).toBe(false);
  });
});

describe('warnIfLocalState', () => {
  it('avisa quando o state é local', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-tfb-'));
    let out = '';
    warnIfLocalState(dir, false, s => { out += s; });
    expect(out).toMatch(/LOCAL/);
    expect(out).toMatch(/tfBackend/);
  });

  it('silencioso quando há backend remoto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-tfb-'));
    let out = '';
    warnIfLocalState(dir, true, s => { out += s; });
    expect(out).toBe('');
  });
});
