const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const https = require('https');
const http = require('http');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

function getReqBaseUrl(req) {
  if (!req) return `http://localhost:${PORT}/api`;
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${host}/api`;
}

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 📡 ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlayITBot/1.0)' }, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.substring(0, 60)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Strategy 1: YouTube oEmbed (title, author — no auth, always works) ──────

async function fetchOEmbed(videoId) {
  try {
    const data = await fetchJson(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (data && data.title) return data;
  } catch (e) {
    console.warn('[oEmbed] Failed:', e.message);
  }
  return null;
}

// ─── Strategy 2: yt-dlp (best quality, works on unblocked/local IPs) ─────────

const PLAYER_CLIENTS = ['ios,android', 'ios', 'android', 'tv_embedded', 'android_embedded'];
const BASE_YTDLP_OPTIONS = { dumpSingleJson: true, noWarnings: true, noCheckCertificate: true };

async function ytdlpWithFallback(url) {
  for (const client of PLAYER_CLIENTS) {
    try {
      console.log(`[yt-dlp] Trying player_client=${client}`);
      const result = await youtubedl(url, {
        ...BASE_YTDLP_OPTIONS,
        extractorArgs: `youtube:player_client=${client}`,
      });
      if (result && (result.title || result.formats)) {
        console.log(`[yt-dlp] Success with player_client=${client}`);
        return result;
      }
    } catch (e) {
      console.warn(`[yt-dlp] Failed with player_client=${client}:`, e.message?.split('\n')[0]);
    }
  }
  return null;
}

// ─── Strategy 3: Piped API (open-source YouTube proxy, works from cloud) ─────

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.adminforge.de',
];

async function fetchFromPiped(videoId) {
  for (const host of PIPED_INSTANCES) {
    try {
      console.log(`[Piped] Trying ${host}`);
      const data = await fetchJson(`${host}/streams/${videoId}`);
      if (data && data.title) {
        console.log(`[Piped] Success from ${host}: ${data.title}`);
        return data;
      }
    } catch (e) {
      console.warn(`[Piped] Failed ${host}:`, e.message);
    }
  }
  return null;
}

function extractBestStreamFromPiped(data) {
  // videoStreams: combined mp4 streams
  if (data.videoStreams && data.videoStreams.length) {
    const best = data.videoStreams.find(s => s.mimeType && s.mimeType.includes('mp4') && s.videoOnly === false)
      || data.videoStreams.find(s => s.mimeType && s.mimeType.includes('mp4'));
    if (best && best.url) return best.url;
  }
  return null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// 1. Health Check
app.get(['/', '/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', server: 'PlayIT Express YouTube Engine', time: new Date().toISOString() });
});

// 2. Video Metadata
app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  const baseUrl = getReqBaseUrl(req);

  // --- Try yt-dlp first (works locally / on non-blocked IPs) ---
  try {
    const output = await ytdlpWithFallback(`https://www.youtube.com/watch?v=${id}`);
    if (output && output.title) {
      const durSec = output.duration || 240;
      const views = output.view_count || 0;
      const bestMp4 =
        output.formats?.find(f => f.url && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none') ||
        output.formats?.find(f => f.url && f.ext === 'mp4') ||
        output.formats?.find(f => f.url);
      return res.json({
        id: output.id || id,
        title: output.title,
        description: output.description || '',
        thumbnailUrl: output.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        videoUrl: `${baseUrl}/stream/${id}`,
        duration: durSec,
        durationFormatted: `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}`,
        channelId: output.uploader_id || 'ch-yt',
        channelName: output.uploader || output.channel || 'YouTube Creator',
        channelAvatarUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        views,
        viewsFormatted: views > 0 ? `${Math.round(views / 1000)}K views` : 'YouTube Video',
        uploadedAt: output.upload_date || '',
        fileSize: bestMp4?.filesize || bestMp4?.filesize_approx || 0,
      });
    }
  } catch (e) {
    console.warn('[yt-dlp] Exhausted, switching to Piped+oEmbed fallback');
  }

  // --- Piped API: metadata + stream info (works on cloud/blocked IPs) ---
  try {
    const [piped, oembed] = await Promise.allSettled([
      fetchFromPiped(id),
      fetchOEmbed(id),
    ]);

    const pipedData = piped.status === 'fulfilled' ? piped.value : null;
    const oembedData = oembed.status === 'fulfilled' ? oembed.value : null;

    const title = pipedData?.title || oembedData?.title || 'YouTube Video';
    const channelName = pipedData?.uploader || oembedData?.author_name || 'YouTube Creator';
    const durSec = pipedData?.duration || 240;
    const views = pipedData?.views || 0;
    const thumbnail = pipedData?.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    if (title !== 'YouTube Video') {
      return res.json({
        id,
        title,
        description: pipedData?.description || '',
        thumbnailUrl: thumbnail,
        videoUrl: `${baseUrl}/stream/${id}`,
        duration: durSec,
        durationFormatted: `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}`,
        channelId: 'ch-yt',
        channelName,
        channelAvatarUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        views,
        viewsFormatted: views > 0 ? `${Math.round(views / 1000)}K views` : 'YouTube Video',
        uploadedAt: pipedData?.uploadedDate || '',
        fileSize: 0,
      });
    }
  } catch (e) {
    console.warn('[Piped+oEmbed] Failed:', e.message);
  }

  // Final stub fallback
  res.json({
    id,
    title: 'YouTube Video',
    description: '',
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    videoUrl: `${baseUrl}/stream/${id}`,
    duration: 240,
    durationFormatted: '4:00',
    channelId: 'ch-yt',
    channelName: 'YouTube Channel',
    channelAvatarUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    views: 0,
    viewsFormatted: 'YouTube Video',
    uploadedAt: '',
    fileSize: 0,
  });
});

// 3. Stream URL Endpoint
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;

  // Strategy 1: yt-dlp
  try {
    const output = await ytdlpWithFallback(`https://www.youtube.com/watch?v=${id}`);
    if (output && output.formats) {
      const bestMp4 =
        output.formats.find(f => f.url && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none') ||
        output.formats.find(f => f.url && f.ext === 'mp4') ||
        output.formats.find(f => f.url);
      if (bestMp4 && bestMp4.url) {
        console.log(`[Stream] yt-dlp resolved stream for ${id}`);
        return res.redirect(bestMp4.url);
      }
    }
  } catch (e) {
    console.warn('[Stream yt-dlp] Failed, trying Piped...');
  }

  // Strategy 2: Piped stream URLs
  try {
    const piped = await fetchFromPiped(id);
    if (piped) {
      const streamUrl = extractBestStreamFromPiped(piped);
      if (streamUrl) {
        console.log(`[Stream] Piped resolved stream for ${id}`);
        return res.redirect(streamUrl);
      }
    }
  } catch (e) {
    console.warn('[Stream Piped] Failed:', e.message);
  }

  // Final fallback
  res.redirect('https://www.w3schools.com/html/mov_bbb.mp4');
});

// ─── Server ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(`🚀 PlayIT Express Engine running on port ${PORT}`);
  console.log(`📡 Base: http://localhost:${PORT}/api`);
  console.log(`🔁 Cloud Fallback: Piped API + YouTube oEmbed`);
  console.log(`================================================`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️ Port ${PORT} already in use.`);
  } else {
    console.error('Server error:', err);
  }
});
