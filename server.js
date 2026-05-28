// QEEP Subtitler Service v1.3
// Cloud-Whisper edition: uses Groq Whisper API (free tier) for transcription.
// Burns karaoke subs via ffmpeg, returns mp4 URL.
//
// POST   /render { video_url, srt_url? OR srt_content? }
// GET    /status/:jobId
// GET    /files/:filename
// GET    /health
// DELETE /admin/clean?older_than_minutes=10&secret=qeep2026

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
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'qeep2026';

// Persistent jobs file — survives cold restarts.
const JOBS_FILE = path.join(TMP, 'jobs.json');
let jobs = loadJobsSync();

function loadJobsSync() {
  try { return new Map(JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))); } catch (e) { return new Map(); }
}
async function saveJobs() {
  try { await fsp.writeFile(JOBS_FILE, JSON.stringify([...jobs.entries()])); } catch (e) {}
}
function setJob(id, data) { jobs.set(id, { ...data, updatedAt: Date.now() }); saveJobs(); }

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ffmpeg: !!ffmpegPath,
    groq: !!GROQ_API_KEY,
    jobs: jobs.size,
    time: new Date().toISOString()
  });
});

// DELETE /admin/clean?older_than_minutes=10&secret=qeep2026
// Чистит зависшие jobs из jobs.json + старые mp4 из tmp
app.delete('/admin/clean', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const olderThanMin = Number(req.query.older_than_minutes || 10);
  const cutoff = Date.now() - olderThanMin * 60 * 1000;
  const doneCutoff = Date.now() - 60 * 60 * 1000;
  let cleanedJobs = 0;
  let cleanedFiles = 0;
  for (const [id, job] of jobs.entries()) {
    const ts = job.updatedAt || job.startedAt || 0;
    const stuck = (job.status === 'processing' || job.status === 'pending') && ts < cutoff;
    const oldDone = (job.status === 'done' || job.status === 'error') && ts < doneCutoff;
    if (stuck || oldDone) {
      jobs.delete(id);
      cleanedJobs++;
    }
  }
  await saveJobs();
  try {
    const files = await fsp.readdir(TMP);
    for (const f of files) {
      if (!f.endsWith('.mp4')) continue;
      try {
        const stat = await fsp.stat(path.join(TMP, f));
        if (stat.mtimeMs < cutoff) { await fsp.unlink(path.join(TMP, f)); cleanedFiles++; }
      } catch (e) {}
    }
  } catch (e) {}
  res.json({ ok: true, cleaned_jobs: cleanedJobs, cleaned_files: cleanedFiles, remaining_jobs: jobs.size });
});

app.use('/files', express.static(TMP, { maxAge: '1h' }));

app.post('/render', async (req, res) => {
  const { video_url, srt_url, srt_content } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  const jobId = randomUUID();
  setJob(jobId, { status: 'pending', startedAt: Date.now() });
  renderJob(jobId, { video_url, srt_url, srt_content }).catch(e => {
    console.error('[' + jobId + '] FAILED:', e);
    setJob(jobId, { status: 'error', error: String(e.message || e) });
  });
  res.json({ jobId, status: 'pending' });
});

app.get('/status/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

async function renderJob(jobId, { video_url, srt_url, srt_content }) {
  const log = (m) => console.log('[' + jobId + ']', m);
  setJob(jobId, { status: 'processing', startedAt: Date.now() });
  const videoPath = path.join(TMP, `${jobId}-in.mp4`);
  const audioPath = path.join(TMP, `${jobId}.mp3`);
  const assPath = path.join(TMP, `${jobId}.ass`);
  const outName = `${jobId}-out.mp4`;
  const outPath = path.join(TMP, outName);

  log('downloading video');
  await downloadToFile(video_url, videoPath);

  let srt = srt_content;
  if (!srt && srt_url) {
    log('fetching srt from url');
    srt = await fetchText(srt_url);
  }
  if (!srt) {
    if (!GROQ_API_KEY) throw new Error('No SRT supplied and GROQ_API_KEY not set');
    log('extracting audio for Groq Whisper');
    await runFfmpeg(['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', '-ar', '16000', '-ac', '1', audioPath]);
    log('calling Groq Whisper');
    srt = await groqTranscribeToSrt(audioPath);
    log('groq returned ' + srt.split('\n\n').filter(Boolean).length + ' segments');
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

  fsp.unlink(videoPath).catch(() => {});
  fsp.unlink(audioPath).catch(() => {});
  fsp.unlink(assPath).catch(() => {});
  setTimeout(() => fsp.unlink(outPath).catch(() => {}), 60 * 60 * 1000);

  setJob(jobId, { status: 'done', url: `${PUBLIC_BASE}/files/${outName}` });
  log('done -> ' + outName);
}

// ── Groq Whisper (free tier) ───────────────────
async function groqTranscribeToSrt(audioPath) {
  const audioBuf = await fsp.readFile(audioPath);
  const boundary = '----QEEP' + randomUUID();
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${GROQ_MODEL}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nru\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
  parts.push(audioBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Groq API ' + resp.status + ': ' + text.slice(0, 500));
  const data = JSON.parse(text);

  const segs = Array.isArray(data.segments) ? data.segments : [];
  if (segs.length === 0 && data.text) {
    return `1\n00:00:00,000 --> 00:00:30,000\n${data.text.trim()}\n\n`;
  }
  let srt = '';
  let idx = 1;
  for (const s of segs) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    srt += `${idx}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${t}\n\n`;
    idx++;
  }
  return srt;
}

function srtTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}
function pad(n, w) { return String(n).padStart(w, '0'); }

// ── ffmpeg ─────────────────────────────────────
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
function escapeForFilter(p) { return p.replace(/\\/g, '/').replace(/:/g, '\\:'); }

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
    const chunks = chunk(allWords, 3);
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
      events.push(`Dialogue: 0,${toAssTime(cs)},${toAssTime(ce)},Default,,0,0,0,,${karaoke}`);
    }
  }
  return assHeader() + events.join('\n') + '\n';
}
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function toSec(h, m, s, ms) { return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0').slice(0, 3)) / 1000; }
function toAssTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
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
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Inter,84,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,10,6,2,90,90,720,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Encoding, Text',
    ''
  ].join('\n');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Subtitler v1.3 listening on :' + PORT + ' (ffmpeg=' + ffmpegPath + ', groq=' + (GROQ_API_KEY ? 'configured' : 'MISSING') + ')');
});
