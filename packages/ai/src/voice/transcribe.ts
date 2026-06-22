import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Language, SUPPORTED_LANGUAGES } from '../i18n/languages';

export interface Recording {
  filePath: string;
  stop: () => Promise<void>;
}

export function startRecording(): Recording {
  const filePath = path.join(os.tmpdir(), `iacmp-voz-${Date.now()}.wav`);
  // whisper.cpp só lê WAV PCM 16-bit — sem -b/-e o sox grava no formato nativo
  // do dispositivo (ex: float32 no CoreAudio do macOS), o que o whisper.cpp
  // interpreta como ruído e produz transcrição corrompida.
  const proc = cp.spawn(
    'sox',
    ['-d', '-r', '16000', '-c', '1', '-b', '16', '-e', 'signed-integer', filePath],
    { stdio: 'ignore' }
  );
  return {
    filePath,
    stop: () =>
      new Promise(resolve => {
        proc.once('exit', () => resolve());
        proc.kill('SIGINT');
      }),
  };
}

export interface TranscriptionResult {
  text: string;
  language: Language | null;
}

// Limiares calibrados com sox stat: silêncio puro fica em ~0.000015 de RMS,
// fala real captada (mesmo baixa) fica acima de ~0.01 — 0.003 dá margem segura.
// Abaixo disso o whisper.cpp não tem conteúdo real pra decodificar e
// "alucina" texto coerente em um idioma aleatório a partir de ruído/silêncio.
const MIN_DURATION_SEC = 0.5;
const MIN_RMS = 0.003;

function isSilentOrTooShort(filePath: string): boolean {
  const result = cp.spawnSync('sox', [filePath, '-n', 'stat'], { encoding: 'utf-8' });
  if (!result || result.status !== 0) return false;

  const stderr = result.stderr || '';
  const durationMatch = stderr.match(/Length \(seconds\):\s*([\d.]+)/);
  const rmsMatch = stderr.match(/RMS\s+amplitude:\s*([\d.]+)/);
  if (!durationMatch || !rmsMatch) return false;

  const durationSec = parseFloat(durationMatch[1]);
  const rms = parseFloat(rmsMatch[1]);
  return durationSec < MIN_DURATION_SEC || rms < MIN_RMS;
}

export type VoicePrerequisiteIssue = 'sox' | 'bin' | 'model';

export function checkVoicePrerequisites(): VoicePrerequisiteIssue | null {
  const soxCheck = cp.spawnSync('which', ['sox']);
  if (soxCheck.status !== 0) return 'sox';

  const bin = process.env.IACMP_WHISPER_BIN || findWhisperBinary();
  if (!bin) return 'bin';

  if (!process.env.IACMP_WHISPER_MODEL) return 'model';

  return null;
}

function findWhisperBinary(): string | null {
  const candidates = ['whisper-cli', 'main', 'whisper'];
  for (const candidate of candidates) {
    const result = cp.spawnSync('which', [candidate]);
    if (result.status === 0) return candidate;
  }
  return null;
}

export function transcribeAudio(filePath: string): TranscriptionResult {
  if (isSilentOrTooShort(filePath)) {
    fs.rmSync(filePath, { force: true });
    return { text: '', language: null };
  }

  const bin = process.env.IACMP_WHISPER_BIN || findWhisperBinary();
  if (!bin) throw new Error('whisper-binary-not-found');

  const model = process.env.IACMP_WHISPER_MODEL;
  if (!model) throw new Error('whisper-model-not-configured');

  const outBase = filePath.replace(/\.wav$/, '');
  const result = cp.spawnSync(
    bin,
    ['-m', model, '-f', filePath, '-l', 'auto', '--output-txt', '-of', outBase],
    { encoding: 'utf-8' }
  );

  const txtPath = `${outBase}.txt`;
  try {
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `whisper exited with status ${result.status}`);
    }

    const stderr = result.stderr || '';
    const match = stderr.match(/auto-detected language:\s*([a-z]{2})/);
    const detected = match ? match[1] : null;
    const language = detected && SUPPORTED_LANGUAGES.includes(detected as Language)
      ? (detected as Language)
      : null;

    const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : '';
    return { text, language };
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(txtPath, { force: true });
  }
}
