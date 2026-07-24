// Vercel serverless function — GET /api/health
// Returns server status + track listing

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.join(__dirname, '..', 'public', 'music');

const CATALOG = [
  {
    id: 'mouse-in-the-labyrinth',
    name: 'Mouse in the Labyrinth',
    title: 'Mouse in the Labyrinth (v2.2)',
    description: "Pondiki's anthem — the mouse that maps the labyrinth.",
    filename: 'mouse-in-the-labyrinth.mp3',
    mimeType: 'audio/mpeg',
  },
  {
    id: 'the-cretan',
    name: 'The Cretan',
    title: 'The Cretan (v2)',
    description: "The Cretan's theme — he built a second brain and gave it a heart.",
    filename: 'the-cretan.mp3',
    mimeType: 'audio/mpeg',
  },
];

function getFileSize(filename) {
  try {
    return fs.statSync(path.join(MUSIC_DIR, filename)).size;
  } catch { return 0; }
}

const BASE = process.env.VERCEL_URL
  ? 'https://' + process.env.VERCEL_URL + '/music/'
  : '/music/';

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    status: 'ok',
    server: 'pondiki-music',
    version: '1.0.0',
    tracks: CATALOG.map((t) => ({
      id: t.id,
      name: t.name,
      title: t.title,
      description: t.description,
      mimeType: t.mimeType,
      size: getFileSize(t.filename),
      url: BASE + t.filename,
    })),
  });
};
