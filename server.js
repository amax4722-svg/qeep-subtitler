// QEEP Subtitler Service
// Burns karaoke-style subtitles into video via ffmpeg.
// POST /render { video_url, srt_url? OR srt_content? }
//   → returns { jobId } immediately
// GET  /status/:jobId
//   → returns { status: 'pending' | 'done' | 'error', url?, error? }
// GET  /files/:filename
//   → serves rendered mp4
// GET  /health
//   → wakeup endpoint for cold starts

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

// Public base URL is the Render service URL, set via env after deploy.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// In-memory job registry. Cleared on cold start; fine because n8n polls within minutes.
const jobs = new Map(); // jobId -> { status, url?, error?, startedAt }

app.get('/health', (req, res) => {
  res.json({ ok: true, ffmpeg: !!ffmpegPath, time: new Date().toISOString() });
});

app.use('/files', express.static(TMP, { maxAge: '1h' }));

app.post('/render', async (req, res) => {
  const { video_url, srt_url, srt_content } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  if (!srt_url && !srt_content) return res.status(400).json({ error: 'srt_url or srt_content required' });

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'pending', startedAt: Date.now() });
  // Fire-and-forget. Client polls /status/:jobId.
  renderJob(jobId, { video_url, srt_url, srt_content }).catch(e => {
    jobs.set(jobId, { status: 'error', error: String(e.message || e) });
  });
  res.json({ jobId, status: 'pending' });
});

app.get('/status/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'job not found (cold-restart?)' });
  res.json(j);
});

async function renderJob(jobId, { video_url, srt_url, srt_content }) {
  const videoPath = path.join(TMP, `${jobId}-in.mp4`);
  const assPath = path.join(TMP, `${jobId}.ass`);
  const outName = `${jobId}-out.mp4`;
  const outPath = path.join(TMP, outName);

  // Download video.
  await downloadToFile(video_url, videoPath);

  // Get SRT text.
  let srt = srt_content;
  if (!srt && srt_url) srt = await fetchText(srt_url);
  if (!srt) throw new Error('no SRT available');

  // Convert to ASS with karaoke styling.
  const ass = srtToAss(srt);
  await fsp.writeFile(assPath, ass, 'utf8');

  // Burn subtitles.
  await runFfmpeg([
    '-y',
    '-i', videoPath,
    '-vf', `ass=${escapeForFilter(assPath)}`,
    '-c:a', 'copy',
    '-preset', 'veryfast',
    '-crf', '23',
    outPath
  ]);

  // Cleanup inputs (keep output for download).
  fsp.unlink(videoPath).catch(() => {});
  fsp.unlink(assPath).catch(() => {});

  // Schedule output cleanup after 1 hour.
  setTimeout(() => fsp.unlink(outPath).catch(() => {}), 60 * 60 * 1000);

  const url = `${PUBLIC_BASE}/files/${outName}`;
  jobs.set(jobId, { status: 'done', url });
}

// ── ffmpeg helper ─────────────────────────────────────────────
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
  // ffmpeg filter graph chokes on backslashes/colons in Windows paths but on Linux it's fine.
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// ── network ───────────────────────────────────────────────────
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

// ── SRT → ASS with karaoke (yellow sweep on current word) ─────
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

    // Split into chunks of <=4 words so each Dialogue line shows max 4 words on screen.
    const allWords = text.split(/\s+/);
    const chunks = chunk(allWords, 4);

    // Allocate time to chunks proportionally to word count.
    const totalDur = endSec - startSec;
    const totalWords = allWords.length;
    let cursor = startSec;
    for (const c of chunks) {
      const dur = totalDur * (c.length / totalWords);
      const chunkStart = cursor;
      const chunkEnd = cursor + dur;
      cursor = chunkEnd;

      // Per-word duration in centiseconds for karaoke fill (\kf).
      const perWordCs = Math.max(5, Math.round((dur / c.length) * 100));
      const karaoke = c.map(w => `{\\kf${perWordCs}}${escapeAssText(w)}`).join(' ');

      events.push(
        `Dialogue: 0,${toAssTime(chunkStart)},${toAssTime(chunkEnd)},Default,,0,0,0,,{\\pos(540,1200)}${karaoke}`
      );
    }
  }

  return assHeader() + events.join('\n') + '\n';
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function toSec(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0').slice(0, 3)) / 1000;
}

function toAssTime(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // ASS uses centiseconds: H:MM:SS.cc
  const csOnly = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(csOnly).padStart(2, '0')}`;
}

function escapeAssText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function assHeader() {
  // Style spec (Sveta workflow parity):
  //   PrimaryColour   = yellow #FFFF00  (active word during \kf sweep)
  //   SecondaryColour = white  #FFFFFF  (words not yet reached)
  //   OutlineColour   = black             OutlineWidth = 12
  //   BackColour      = black             ShadowDepth  = 8
  //   Alignment 5 = center middle (anchor for \pos)
  //   PlayRes 1080x1920 vertical, font Inter 100pt bold
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

// ── server start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Subtitler listening on :${PORT} (ffmpeg=${ffmpegPath})`);
});
