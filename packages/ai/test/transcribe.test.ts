import { EventEmitter } from 'events';

jest.mock('child_process');
jest.mock('fs');

import * as cp from 'child_process';
import * as fs from 'fs';
import {
  startRecording,
  transcribeAudio,
  checkVoicePrerequisites,
} from '../src/voice/transcribe';

const REAL_SPEECH_STAT = {
  status: 0,
  stderr: 'Length (seconds):      4.679250\nRMS     amplitude:     0.011422\n',
  stdout: '',
} as any;

const mockedCp = cp as jest.Mocked<typeof cp>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('startRecording', () => {
  test('grava com sox e stop() resolve apos o processo encerrar', async () => {
    const fakeProc = new EventEmitter() as any;
    fakeProc.kill = jest.fn(() => fakeProc.emit('exit'));
    mockedCp.spawn.mockReturnValue(fakeProc);

    const recording = startRecording();
    expect(mockedCp.spawn).toHaveBeenCalledWith(
      'sox',
      expect.arrayContaining(['-d']),
      expect.objectContaining({ stdio: 'ignore' })
    );
    expect(recording.filePath).toMatch(/\.wav$/);

    await recording.stop();
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGINT');
  });
});

describe('transcribeAudio', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV, IACMP_WHISPER_BIN: 'whisper-cli', IACMP_WHISPER_MODEL: '/models/ggml-base.bin' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('retorna texto e idioma detectado quando whisper.cpp roda com sucesso', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce(REAL_SPEECH_STAT) // sox stat
      .mockReturnValueOnce({
        status: 0,
        stderr: 'whisper_full_with_state: auto-detected language: en (p = 0.99)',
        stdout: '',
      } as any); // whisper-cli
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('hello world' as any);

    const result = transcribeAudio('/tmp/audio.wav');

    expect(result.text).toBe('hello world');
    expect(result.language).toBe('en');
    expect(mockedFs.rmSync).toHaveBeenCalled();
  });

  test('retorna idioma null quando idioma detectado nao e suportado', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce(REAL_SPEECH_STAT) // sox stat
      .mockReturnValueOnce({
        status: 0,
        stderr: 'auto-detected language: fr (p = 0.80)',
        stdout: '',
      } as any); // whisper-cli
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('bonjour' as any);

    const result = transcribeAudio('/tmp/audio.wav');
    expect(result.language).toBeNull();
  });

  test('retorna texto vazio quando nao ha arquivo de saida (silencio na resposta do whisper)', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce(REAL_SPEECH_STAT) // sox stat
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: '' } as any); // whisper-cli
    mockedFs.existsSync.mockReturnValue(false);

    const result = transcribeAudio('/tmp/audio.wav');
    expect(result.text).toBe('');
    expect(result.language).toBeNull();
  });

  test('lanca erro quando o processo whisper.cpp falha', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce(REAL_SPEECH_STAT) // sox stat
      .mockReturnValueOnce({ status: 1, stderr: 'model nao encontrado', stdout: '' } as any); // whisper-cli
    mockedFs.existsSync.mockReturnValue(false);

    expect(() => transcribeAudio('/tmp/audio.wav')).toThrow('model nao encontrado');
  });

  test('lanca erro quando IACMP_WHISPER_MODEL nao esta configurado', () => {
    mockedCp.spawnSync.mockReturnValueOnce(REAL_SPEECH_STAT); // sox stat
    delete process.env.IACMP_WHISPER_MODEL;
    expect(() => transcribeAudio('/tmp/audio.wav')).toThrow('whisper-model-not-configured');
  });

  test('retorna texto vazio sem chamar o whisper quando o audio e curto demais', () => {
    mockedCp.spawnSync.mockReturnValueOnce({
      status: 0,
      stderr: 'Length (seconds):      0.300000\nRMS     amplitude:     0.011422\n',
      stdout: '',
    } as any);

    const result = transcribeAudio('/tmp/audio.wav');

    expect(result).toEqual({ text: '', language: null });
    expect(mockedCp.spawnSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.rmSync).toHaveBeenCalledWith('/tmp/audio.wav', { force: true });
  });

  test('retorna texto vazio sem chamar o whisper quando o audio e silencio (RMS baixo)', () => {
    mockedCp.spawnSync.mockReturnValueOnce({
      status: 0,
      stderr: 'Length (seconds):      3.000000\nRMS     amplitude:     0.000015\n',
      stdout: '',
    } as any);

    const result = transcribeAudio('/tmp/audio.wav');

    expect(result).toEqual({ text: '', language: null });
    expect(mockedCp.spawnSync).toHaveBeenCalledTimes(1);
  });

  test('segue para o whisper quando o sox stat falha ou nao retorna saida reconhecivel', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce({ status: 1, stderr: '', stdout: '' } as any) // sox stat falhou
      .mockReturnValueOnce({
        status: 0,
        stderr: 'auto-detected language: pt (p = 0.99)',
        stdout: '',
      } as any); // whisper-cli
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('oi' as any);

    const result = transcribeAudio('/tmp/audio.wav');
    expect(result.text).toBe('oi');
  });
});

describe('checkVoicePrerequisites', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.IACMP_WHISPER_BIN;
    delete process.env.IACMP_WHISPER_MODEL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('retorna "sox" quando sox nao esta no PATH', () => {
    mockedCp.spawnSync.mockReturnValue({ status: 1 } as any);
    expect(checkVoicePrerequisites()).toBe('sox');
  });

  test('retorna "bin" quando sox existe mas whisper nao', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce({ status: 0 } as any) // which sox
      .mockReturnValue({ status: 1 } as any); // which whisper-cli/main/whisper
    expect(checkVoicePrerequisites()).toBe('bin');
  });

  test('retorna "model" quando sox e bin existem mas falta IACMP_WHISPER_MODEL', () => {
    mockedCp.spawnSync
      .mockReturnValueOnce({ status: 0 } as any) // which sox
      .mockReturnValueOnce({ status: 0 } as any); // which whisper-cli
    expect(checkVoicePrerequisites()).toBe('model');
  });

  test('retorna null quando tudo esta configurado', () => {
    process.env.IACMP_WHISPER_MODEL = '/models/ggml-base.bin';
    mockedCp.spawnSync
      .mockReturnValueOnce({ status: 0 } as any) // which sox
      .mockReturnValueOnce({ status: 0 } as any); // which whisper-cli
    expect(checkVoicePrerequisites()).toBeNull();
  });
});
