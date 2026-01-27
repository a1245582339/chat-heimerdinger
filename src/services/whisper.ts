import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consola } from 'consola';

const WHISPER_MODEL_PATH = join(
  process.env.HOME || '/home/dev',
  '.local/share/whisper/ggml-small.bin'
);
const WHISPER_CLI = 'whisper-cli';

export class WhisperService {
  private modelPath: string;

  constructor(modelPath: string = WHISPER_MODEL_PATH) {
    this.modelPath = modelPath;
  }

  /**
   * Check if Whisper is available
   */
  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.modelPath)) {
      consola.warn(`Whisper model not found at ${this.modelPath}`);
      return false;
    }

    return new Promise((resolve) => {
      const proc = spawn(WHISPER_CLI, ['-h'], { stdio: 'ignore' });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Transcribe audio buffer to text
   * @param audioBuffer Audio file buffer (any format supported by ffmpeg)
   * @param language Language code (default: auto-detect)
   */
  async transcribe(audioBuffer: Buffer, language = 'auto'): Promise<string> {
    const tempDir = join(tmpdir(), 'heimerdinger-whisper');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const inputFile = join(tempDir, `input-${Date.now()}.webm`);
    const wavFile = join(tempDir, `audio-${Date.now()}.wav`);

    try {
      // Write input audio to temp file
      writeFileSync(inputFile, audioBuffer);

      // Convert to WAV (16kHz mono, required by whisper.cpp)
      await this.convertToWav(inputFile, wavFile);

      // Run whisper transcription
      const text = await this.runWhisper(wavFile, language);

      return text.trim();
    } finally {
      // Cleanup temp files
      try {
        if (existsSync(inputFile)) unlinkSync(inputFile);
        if (existsSync(wavFile)) unlinkSync(wavFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Convert audio file to WAV format for whisper.cpp
   */
  private convertToWav(inputFile: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-i', inputFile,
        '-ar', '16000',     // 16kHz sample rate
        '-ac', '1',         // Mono
        '-c:a', 'pcm_s16le', // 16-bit PCM
        '-y',               // Overwrite output
        outputFile,
      ];

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg conversion failed: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`ffmpeg not found or failed to start: ${err.message}`));
      });
    });
  }

  /**
   * Run whisper-cli on audio file
   */
  private runWhisper(wavFile: string, language: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.modelPath,
        '-l', language,
        '-nt',              // No timestamps
        '-np',              // No prints except results
        '-f', wavFile,
      ];

      consola.debug(`Running whisper: ${WHISPER_CLI} ${args.join(' ')}`);

      const proc = spawn(WHISPER_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          consola.error('Whisper stderr:', stderr);
          reject(new Error(`Whisper transcription failed with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`whisper-cli not found or failed to start: ${err.message}`));
      });
    });
  }
}
