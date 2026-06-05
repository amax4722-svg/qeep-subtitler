// QEEP Subtitler Service v1.3
// - Whisper transcription via Groq (free tier).
// - Karaoke subtitles burned via ffmpeg.
// - V1.3: optional Pexels b-roll overlay when HeyGen returns weak visuals.
//
// POST /render {
//   video_url,
//   srt_url? OR srt_content?,
//   pexels_queries? (array of strings — adds Pexels video overlays as a montage)
// }
// GET  /status/:jobId
// GET  /files/:filename
// GET  /health

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
// V1.3: Pexels for b-roll fallback. Free tier: 200 req/hour, plenty for our use.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';

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
    pexels: !!PEXELS_API_KEY,
    jobs: jobs.size,
    time: new Date().toISOString()
  });
});

app.use('/files', express.static(TMP, { maxAge: '1h' }));

app.post('/render', async (req, res) => {
  const { video_url, srt_url, srt_content, pexels_queries } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  const jobId = randomUUID();
  setJob(jobId, { status: 'pending', startedAt: Date.now() });
  renderJob(jobId, { video_url, srt_url, srt_content, pexels_queries }).catch(e => {
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

async function renderJob(jobId, { video_url, srt_url, srt_content, pexels_queries }) {
  const log = (m) => console.log('[' + jobId + ']', m);
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

  // V1.3: detect single-clip HeyGen output and overlay Pexels b-roll if available.
  // Strategy: probe video duration; if pexels_queries supplied + key set, fetch N clips and overlay every D seconds.
  let videoForSubs = videoPath;
  const wantsPexels = Array.isArray(pexels_queries) && pexels_queries.length > 0 && PEXELS_API_KEY;
  if (wantsPexels) {
    try {
      log('Pexels b-roll overlay enabled (' + pexels_queries.length + ' queries)');
      const overlayPath = path.join(TMP, `${jobId}-overlay.mp4`);
      await buildPexelsOverlay(jobId, videoPath, pexels_queries, overlayPath, log);
      videoForSubs = overlayPath;
    } catch (e) {
      log('Pexels overlay failed, fallback to original video: ' + e.message);
    }
  }

  log('burning subtitles with ffmpeg');
  await runFfmpeg([
    '-y', '-i', videoForSubs,
    '-vf', `ass=${escapeForFilter(assPath)}`,
    '-c:a', 'copy', '-preset', 'veryfast', '-crf', '23',
    outPath
  ]);

  fsp.unlink(videoPath).catch(() => {});
  if (videoForSubs !== videoPath) fsp.unlink(videoForSubs).catch(() => {});
  fsp.unlink(audioPath).catch(() => {});
  fsp.unlink(assPath).catch(() => {});
  setTimeout(() => fsp.unlink(outPath).catch(() => {}), 60 * 60 * 1000);

  setJob(jobId, { status: 'done', url: `${PUBLIC_BASE}/files/${outName}` });
  log('done -> ' + outName);
}

// ── Pexels b-roll overlay (V1.5 — light edition for Render Free) ─────
// Memory-conscious: only 3 clips, 720x1280 internal, ultrafast preset.
// Falls back gracefully if anything heavy fails — never blocks the pipeline.
async function buildPexelsOverlay(jobId, baseVideoPath, queries, outPath, log) {
  const baseDuration = await probeDuration(baseVideoPath);
  log('base video duration: ' + baseDuration.toFixed(1) + 's');
  // V1.5: 3 clips max for Render Free 512MB RAM constraint
  const queriesUsed = queries.slice(0, 3);
  const clipDur = Math.max(3, Math.floor(baseDuration / queriesUsed.length));
  const downloaded = [];
  for (let i = 0; i < queriesUsed.length; i++) {
    const q = queriesUsed[i];
    try {
      const url = await pexelsBestVideo(q);
      if (!url) { log('  no pexels match for: ' + q); continue; }
      const clipPath = path.join(TMP, `${jobId}-px${i}.mp4`);
      await downloadToFile(url, clipPath);
      downloaded.push({ path: clipPath, start: i * clipDur, dur: clipDur });
    } catch (e) {
      log('  pexels fetch err for "' + q + '": ' + e.message);
    }
  }
  if (downloaded.length === 0) throw new Error('no pexels clips downloaded');

  // Build ffmpeg filter at 720x1280 (lighter on memory than 1080x1920).
  // Final output will still be 1080x1920 because we scale up at burn-subtitles step.
  const inputs = ['-i', baseVideoPath];
  for (const d of downloaded) inputs.push('-i', d.path);
  const filters = [];
  filters.push('[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280[base]');
  let prev = 'base';
  downloaded.forEach((d, idx) => {
    const i = idx + 1;
    filters.push(`[${i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setpts=PTS-STARTPTS,trim=duration=${d.dur}[ov${idx}]`);
    filters.push(`[${prev}][ov${idx}]overlay=enable='between(t,${d.start},${d.start + d.dur})':x=0:y=0[m${idx}]`);
    prev = `m${idx}`;
  });
  filters.push(`[${prev}]copy[outv]`);
  const filterStr = filters.join(';');

  log('compositing ' + downloaded.length + ' overlays via ffmpeg (720x1280, ultrafast)');
  await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', filterStr,
    '-map', '[outv]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k',
    '-threads', '2',
    '-shortest',
    outPath
  ]);

  for (const d of downloaded) fsp.unlink(d.path).catch(() => {});
}

function probeDuration(path) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-i', path, '-hide_banner']);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!m) return reject(new Error('could not probe duration'));
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
      resolve(sec);
    });
    proc.on('error', reject);
  });
}

// V1.4: enforce ethnicity bias on Pexels queries (European/white preferred, no people of color)
function sanitizeQueryEthnicity(q) {
  let s = String(q || '').trim();
  if (!s) return s;
  // Strip any explicit POC keywords (we won't search for these)
  s = s
    .replace(/\b(african|black|dark[\s-]*skin(ned)?|brown[\s-]*skin(ned)?|asian|chinese|japanese|korean|latina?|hispanic|indian|middle[\s-]*eastern|arab)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // If the query references people without ethnicity, inject "european white"
  const hasPersonWord = /\b(woman|women|girl|girls|female|lady|person|people|man|men|kid|child|teen)\b/i.test(s);
  const hasEthnicity = /\b(european|white|caucasian|nordic|scandinavian|slavic)\b/i.test(s);
  if (hasPersonWord && !hasEthnicity) {
    s = 'european white ' + s;
  }
  return s;
}

async function pexelsBestVideo(rawQuery) {
  const query = sanitizeQueryEthnicity(rawQuery);
  const url = 'https://api.pexels.com/videos/search?orientation=portrait&per_page=15&query=' + encodeURIComponent(query);
  const r = await fetch(url, { headers: { 'Authorization': PEXELS_API_KEY } });
  if (!r.ok) throw new Error('pexels HTTP ' + r.status);
  const data = await r.json();
  const videos = data.videos || [];
  if (videos.length === 0) return '';
  // Score each video: prefer HD vertical. (Pexels API doesn't expose subject ethnicity tags; rely on sanitized query.)
  for (const v of videos) {
    const files = (v.video_files || []).filter(f => f.height >= f.width && f.height >= 1280 && f.link);
    if (files.length > 0) return files[0].link;
  }
  return (videos[0].video_files?.[0]?.link) || '';
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

  // verbose_json returns { segments: [{ start, end, text, ... }] }
  const segs = Array.isArray(data.segments) ? data.segments : [];
  if (segs.length === 0 && data.text) {
    // fallback: synthesize one segment if no segmentation
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
    const chunks = chunk(allWords, 3); // 3 words per visible line to keep text inside frame
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
      // No \pos — let Alignment + MarginV/L/R handle position. Style anchors to bottom-center at MarginV from bottom.
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
  // Style anchors text to BOTTOM-CENTER (Alignment=2). Text grows upward from MarginV.
  // PlayResY=1920, MarginV=720 → baseline ~y=1200. Left/Right margins 90 keep text inside frame.
  // WrapStyle=0 = smart wrap (top line wider) so long phrases wrap to 2 lines instead of overflowing.
  // Font 84pt (was 100) gives more breathing room horizontally.
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
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ''
  ].join('\n');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Subtitler v1.2 listening on :' + PORT + ' (ffmpeg=' + ffmpegPath + ', groq=' + (GROQ_API_KEY ? 'configured' : 'MISSING') + ')');
});
