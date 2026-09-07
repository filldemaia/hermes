import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { srtToVtt } from './srt';

function runProc(cmd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: opts.maxBuffer || 256 * 1024 * 1024, timeout: opts.timeout ?? 120000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.message += `\nstderr: ${String(stderr).slice(0, 500)}`;
          reject(err);
        } else {
          resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: String(stderr) });
        }
      }
    );
  });
}

export interface TrackInfo {
  /** Índex global del flux a la contenedora (estable, el que fa servir el client). */
  index: number;
  /** Posició del flux dins la seva classe (àudio/subs): és el que espera `-map 0:a:N` / `0:s:N`. */
  mapPos: number;
  lang: string | null;
  channels: number | null;
  codec: string | null;
  title: string | null;
}

export interface TrackSet {
  audios: TrackInfo[];
  subtitles: TrackInfo[];
  defaultAudioIndex: number | null;
}

const pickLang = (tags: Record<string, unknown> | undefined): string | null => {
  const l = tags && (tags.language as string | undefined);
  return l && l !== 'und' ? l.toLowerCase() : null;
};

const pickTitle = (tags: Record<string, unknown> | undefined): string | null => {
  const t = tags && (tags.title as string | undefined);
  return t && t.length ? t : null;
};

export async function probeFile(filePath: string): Promise<{ streams: Record<string, unknown>[]; format: Record<string, unknown> }> {
  const { stdout } = await runProc('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]);
  const json = JSON.parse(stdout.toString('utf8'));
  return { streams: json.streams || [], format: json.format || {} };
}

export async function getTracks(filePath: string): Promise<TrackSet> {
  const { streams } = await probeFile(filePath);
  const audios: TrackInfo[] = [];
  const subs: TrackInfo[] = [];
  for (const s of streams) {
    const st = s as { index: number; codec_type: string; codec_name?: string; channels?: number; tags?: Record<string, unknown> };
    if (st.codec_type === 'audio') {
      audios.push({ index: st.index, mapPos: audios.length, lang: pickLang(st.tags), channels: st.channels ?? null, codec: st.codec_name ?? null, title: pickTitle(st.tags) });
    } else if (st.codec_type === 'subtitle') {
      subs.push({ index: st.index, mapPos: subs.length, lang: pickLang(st.tags), channels: null, codec: st.codec_name ?? null, title: pickTitle(st.tags) });
    }
  }
  return {
    audios,
    subtitles: subs,
    defaultAudioIndex: audios.length ? audios[0].index : null,
  };
}

export async function extractEmbeddedSubtitleVtt(filePath: string, streamIndex: number): Promise<string> {
  // Intent preferent: WebVTT directe
  try {
    const { stdout } = await runProc('ffmpeg', ['-i', filePath, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    const out = stdout.toString('utf8');
    if (out.includes('WEBVTT')) return out;
  } catch {
    /* prova srt */
  }
  try {
    const { stdout } = await runProc('ffmpeg', ['-i', filePath, '-map', `0:s:${streamIndex}`, '-f', 'srt', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    return srtToVtt(stdout.toString('utf8'));
  } catch {
    throw new Error(`No s'ha pogut extreure el subtítol incrustat ${streamIndex}`);
  }
}

/**
 * Còdecs d'àudio que els navegadors reprodueixen directament dins MP4.
 * Qualsevol altra cosa (AC-3, E-AC-3, DTS...) es transcodifica a AAC.
 */
export const BROWSER_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/**
 * Construeix el remux (vídeo copiat + pista d'àudio alternativa) a la cache,
 * de manera atòmica (.part → rename) i amb format MP4 explícit.
 * Retorna el camí del fitxer en cache.
 */
export async function buildRemuxFile(
  filePath: string,
  tracks: TrackSet,
  audioIndex: number,
  cacheDir: string,
  key: string
): Promise<string> {
  const audio = tracks.audios.find((a) => a.index === audioIndex);
  if (!audio) {
    const err: Error & { code?: string } = new Error(`Pista d'àudio ${audioIndex} no trobada`);
    err.code = 'ENOENT';
    throw err;
  }
  const outFile = path.join(cacheDir, `${key}_a${audioIndex}.mp4`);
  fs.mkdirSync(cacheDir, { recursive: true });
  // Fitxers en cache de menys d'1 KB = remux inacabat/corromput → es tornen a construir.
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1024) return outFile;
  const partial = `${outFile}.part`;
  fs.rmSync(partial, { force: true });
  const copyAudio = BROWSER_AUDIO_CODECS.has(String(audio.codec ?? ''));
  const audioArgs = copyAudio
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', (audio.channels ?? 2) > 2 ? '320k' : '192k'];
  await runProc(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-map', '0:v:0',
      '-map', `0:a:${audio.mapPos}`,
      '-c:v', 'copy',
      ...audioArgs,
      '-movflags', '+faststart',
      '-f', 'mp4',
      partial,
    ],
    { timeout: 0 }
  );
  fs.renameSync(partial, outFile);
  return outFile;
}

export function videoMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    ts: 'video/mp2t',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
  };
  return map[ext] || 'application/octet-stream';
}

export function ffmpegAvailable(): boolean {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}