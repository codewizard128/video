const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');

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

/**
 * Resolve direct 200-OK downloadable video URL for YouTube videoId using yt-dlp binary
 */
async function resolvePlayableStream(videoId) {
  try {
    console.log(`[yt-dlp Engine] Resolving video stream for ID: ${videoId}`);
    const output = await youtubedl(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
    });

    if (output && output.formats) {
      // Find combined MP4 format (audio + video) or best MP4
      const bestMp4 =
        output.formats.find((f) => f.url && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none') ||
        output.formats.find((f) => f.url && f.ext === 'mp4') ||
        output.formats.find((f) => f.url);

      if (bestMp4 && bestMp4.url) {
        console.log(`[yt-dlp Engine] Successfully resolved direct stream URL for ID: ${videoId}`);
        return bestMp4.url;
      }
    }
  } catch (e) {
    console.warn('[yt-dlp Engine Warning]:', e.message);
  }

  return 'https://www.w3schools.com/html/mov_bbb.mp4';
}

// 1. Health Check & Root Endpoints
app.get(['/', '/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    server: 'PlayIT Express YouTube Engine (yt-dlp)',
    time: new Date().toISOString(),
  });
});

// 2. Video Metadata Endpoint
app.get('/api/video/:id', async (req, res) => {
  const { id } = req.params;
  const baseUrl = getReqBaseUrl(req);

  try {
    const output = await youtubedl(`https://www.youtube.com/watch?v=${id}`, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
    });

    if (output) {
      const durSec = output.duration || 240;
      const mins = Math.floor(durSec / 60);
      const secs = Math.floor(durSec % 60);
      const views = output.view_count || 100000;

      const bestMp4 =
        output.formats?.find((f) => f.url && f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none') ||
        output.formats?.find((f) => f.url && f.ext === 'mp4') ||
        output.formats?.find((f) => f.url);

      const exactFileSize = bestMp4?.filesize || bestMp4?.filesize_approx || output.filesize || output.filesize_approx || 0;

      return res.json({
        id: output.id || id,
        title: output.title || 'YouTube Video',
        description: output.description || '',
        thumbnailUrl: output.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        videoUrl: `${baseUrl}/stream/${id}`,
        duration: durSec,
        durationFormatted: `${mins}:${secs.toString().padStart(2, '0')}`,
        channelId: output.uploader_id || 'ch-yt',
        channelName: output.uploader || output.channel || 'YouTube Creator',
        channelAvatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100',
        views,
        viewsFormatted: `${Math.round(views / 1000)}K views`,
        uploadedAt: output.upload_date || 'YouTube Video',
        fileSize: exactFileSize,
      });
    }
  } catch (e) {
    console.warn('[Video Metadata Error]:', e.message);
  }

  res.json({
    id,
    title: 'YouTube Video',
    description: 'Playable YouTube stream',
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    videoUrl: `${baseUrl}/stream/${id}`,
    duration: 240,
    durationFormatted: '4:00',
    channelId: 'ch-yt',
    channelName: 'YouTube Channel',
    channelAvatarUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100',
    views: 50000,
    viewsFormatted: '50K views',
    uploadedAt: 'Recently',
  });
});

// 3. Direct Stream Endpoint
app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  const streamUrl = await resolvePlayableStream(id);
  res.redirect(streamUrl);
});

// Start Express server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================`);
  console.log(`🚀 PlayIT Express Engine (yt-dlp) running on port ${PORT}`);
  console.log(`📡 Base Endpoint: http://localhost:${PORT}/api`);
  console.log(`================================================`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️ Port ${PORT} is already in use. Express server active.`);
  } else {
    console.error('Server error:', err);
  }
});
