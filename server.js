// QEEP Subtitler Service v1.1
// - Burns karaoke-style subtitles into video via ffmpeg.
// - If no SRT supplied, transcribes Russian speech with Whisper (transformers.js) automatically.
// POST /render { video_url, srt_url? OR srt_content? }
//   → returns { jobId } immediately
// GET  /status/:jobId
//   → { status: 'pending' | 'done' | 'error', url?, error? }
// GET  /files/:filename → serves rendered mp4
// GET  /health → wakeup endpoint

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const https = require('https');
const http = require('http');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json({ limit: '20mb' }));

const TMP = process.env.TMP_DIR || '/tmp/subtitler';
fs.mkdirSync(TMP, { recursive: true });

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny';

// Lazy Whisper init (transformers.js downloads model on first call ~75 MB to /tmp).
let _transcriber = null;
async function getTranscriber() {
  if (_transcriber) return _transcriber;
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = path.join(TMP, 'models');
  env.allowLocalModels = false;
  _transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL);
  return _transcriber;
}

const jobs = new Map();

app.get('/health', (req, res) => {
  res.json({ ok: true, ffmpeg: !!ffmpegPath, whisperReady: !!_transcriber, time: new Date().toISOString() });
});

app.use('/files', express.static(TMP, { maxAge: '1h' }));

app.post('/render', async (req, res) => {
  const { video_url, srt_url, srt_content } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  const jobId = randomUUID();
  jobs.set(jobId, { status: 'pending', startedAt: Date.now() });
  renderJob(jobId, { video_url, srt_url, srt_content }).catch(e => {
    console.error('[' + jobId + '] FAILED:', e);
    jobs.set(jobId, { status: 'error', error: String(e.message || e) });
  });
  res.json({ jobId, status: 'pending' });
});

app.get('/status/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'job not found (cold-restart cleared memory?)' });
  res.json(j);
});

async function renderJob(jobId, { video_url, srt_url, srt_content }) {
  const log = (m) => console.log('[' + jobId + ']', m);
  const videoPath = path.join(TMP, `${jobId}-in.mp4`);
  const wavPath = path.join(TMP, `${jobId}.wav`);
  const assPath = path.join(TMP, `${jobId}.ass`);
  const outName = `${jobId}-out.mp4`;
  const outPath = path.join(TMP, outName);

  log('downloading video');
  await downloadToFile(video_url, videoPath);

  // SOURCE OF SUBTITLES:
  // 1) inline srt_content, 2) srt_url, 3) Whisper transcription from audio
  let srt = srt_content;
  if (!srt && srt_url) {
    log('fetching srt from url');
    srt = await fetchText(srt_url);
  }
  if (!srt) {
    log('no SRT supplied — extracting audio for Whisper');
    await runFfmpeg(['-y', '-i', videoPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
    log('loading Whisper model (' + WHISPER_MODEL + ')');
    const transcriber = await getTranscriber();
    log('running Whisper transcription');
    const audioData = await loadWavAsFloat32(wavPath);
    const result = await transcriber(audioData, {
      language: 'russian',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true
    });
    srt = chunksToSrt(result.chunks || []);
    log('whisper produced ' + (result.chunks?.length || 0) + ' chunks');
  }

  if (!srt || srt.trim().length === 0) throw new Error('no subtitles could be produced');

  const ass = srtToAss(srt);
  await fsp.writeFile(assPath, ass, 'utf8');

  log('burning subtitles with ffmpeg');
  await runFfmpeg([
    '-y', '-i', videoPath,
    '-vf', `ass=${escapeForFilter(assPath)}`,
    '-c:a', 'copy', '-preset', 'veryfast', '-crf', '23',
    outPath
  ]);

  // Cleanup intermediates.
  fsp.unlink(videoPath).catch(() => {});
  fsp.unlink(wavPath).catch(() => {});
  fsp.unlink(assPath).catch(() => {});
  setTimeout(() => fsp.unlink(outPath).catch(() => {}), 60 * 60 * 1000);

  jobs.set(jobId, { status: 'done', url: `${PUBLIC_BASE}/files/${outName}` });
  log('done -> ' + outName);
}

async function loadWavAsFloat32(wavPath) {
  const { WaveFile } = require('wavefile');
  const buf = await fsp.readFile(wavPath);
  const wav = new WaveFile(buf);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0]; // stereo → take left
  return samples;
}

function chunksToSrt(chunks) {
  // chunks: [{ text, timestamp: [start, end] }, ...]
  let srt = '';
  let idx = 1;
  for (const c of chunks) {
    const t = (c.timestamp || []);
    const start = Number(t[0] || 0);
    const end = Number(t[1] || start + 1);
    if (end <= start) continue;
    const text = String(c.text || '').trim();
    if (!text) continue;
    srt += `${idx}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n\n`;
    idx++;
  }
  return srt;
}

function srtTime(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}
function pad(n, w) { return String(n).padStart(w, '0'); }

// ── ffmpeg helper ──────────────────────────────
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-1500)));
    });
  });
}
function escapeForFilter(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ── network ─────────────────────────────────────
function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        downloadToFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error('download HTTP ' + res.statusCode + ' for ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('fetch HTTP ' + res.statusCode));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ── SRT → ASS karaoke ───────────────────────────
function srtToAss(srtRaw) {
  const blocks = String(srtRaw).replace(/\r/g, '').trim().split(/\n{2,}/);
  const events = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const timingLine = lines.find(l => /-->/g.test(l));
    if (!timingLine) continue;
    const m = timingLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) continue;
    const startSec = toSec(m[1], m[2], m[3], m[4]);
    const endSec = toSec(m[5], m[6], m[7], m[8]);
    const textIdx = lines.indexOf(timingLine) + 1;
    const text = lines.slice(textIdx).join(' ').trim();
    if (!text) continue;

    const allWords = text.split(/\s+/);
    const chunks = chunk(allWords, 4);

    const totalDur = endSec - startSec;
    const totalWords = allWords.length;
    let cursor = startSec;
    for (const c of chunks) {
      const dur = totalDur * (c.length / totalWords);
      const cs = cursor;
      const ce = cursor + dur;
      cursor = ce;
      const perWordCs = Math.max(5, Math.round((dur / c.length) * 100));
      const karaoke = c.map(w => `{\\kf${perWordCs}}${escapeAssText(w)}`).join(' ');
      events.push(`Dialogue: 0,${toAssTime(cs)},${toAssTime(ce)},Default,,0,0,0,,{\\pos(540,1200)}${karaoke}`);
    }
  }

  return assHeader() + events.join('\n') + '\n';
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function toSec(h, m, s, ms) { return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0').slice(0, 3)) / 1000; }
function toAssTime(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function escapeAssText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
function assHeader() {
  return [
    '[Script Info]',
    'Title: QEEP karaoke subs',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Inter,100,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,12,8,5,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ''
  ].join('\n');
}

// ── start ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Subtitler v1.1 listening on :' + PORT + ' (ffmpeg=' + ffmpegPath + ', whisperModel=' + WHISPER_MODEL + ')');
});
