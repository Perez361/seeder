import express from 'express'
import multer from 'multer'
import WebTorrent from 'webtorrent'
import type { Torrent, TorrentFile } from 'webtorrent'
import { Server } from 'socket.io'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import os from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001
const CLIENT_DIST = path.join(__dirname, '../../client/dist')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const client = new WebTorrent()
const upload = multer({ dest: 'uploads/' })
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads')

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

// Log top-level WebTorrent errors so they don't crash the process silently
client.on('error', (err) => console.error('WebTorrent client error:', err))

app.use(express.json())
app.use('/files', express.static(DOWNLOAD_DIR))

app.get('/download/:torrent/:file', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.torrent, req.params.file)
  if (!filePath.startsWith(DOWNLOAD_DIR)) { res.status(403).send('Forbidden'); return }
  res.download(filePath)
})
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST))
  app.get('/*splat', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')))
}

app.get('/api/torrents', (_req, res) => {
  res.json(client.torrents.map((t: Torrent) => ({
    id: t.infoHash,
    name: t.name,
    progress: Math.round(t.progress * 100),
    downloadSpeed: t.downloadSpeed,
    numPeers: t.numPeers,
    done: t.done,
    files: t.done ? t.files.map((f: TorrentFile) => ({
      name: f.name,
      url: `/download/${encodeURIComponent(t.name)}/${encodeURIComponent(f.name)}`,
      size: f.length,
    })) : [],
  })))
})

app.post('/api/torrent/upload', upload.single('torrent'), (req, res) => {
  const torrentPath = req.file?.path
  if (!torrentPath) { res.status(400).json({ error: 'No file' }); return }
  addTorrent(torrentPath, res)
})

app.post('/api/torrent/magnet', (req, res) => {
  const { magnet } = req.body
  if (!magnet) { res.status(400).json({ error: 'No magnet link' }); return }
  addTorrent(injectTrackers(magnet), res)
})

// Public HTTPS trackers — used as fallback when UDP/DHT is blocked on the host network.
const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'https://tracker.opentrackr.org/announce',
  'https://tracker.gbitt.info/announce',
  'https://tracker.tamersunion.org/announce',
]

function injectTrackers(magnet: string): string {
  const extra = PUBLIC_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')
  return magnet + extra
}

// Parse infoHash from a magnet URI so we can respond immediately without
// waiting for peer metadata (which can hang for seconds or indefinitely).
function parseMagnetHash(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

function setupTorrentEvents(torrent: Torrent) {
  const interval = setInterval(() => {
    io.emit(`progress:${torrent.infoHash}`, {
      progress: Math.round(torrent.progress * 100),
      downloadSpeed: torrent.downloadSpeed,
      downloaded: torrent.downloaded,
      length: torrent.length,
      done: torrent.done,
      numPeers: torrent.numPeers,
    })
    if (torrent.done) clearInterval(interval)
  }, 1000)

  torrent.on('done', () => {
    console.log(`Done: ${DOWNLOAD_DIR}/${torrent.name}`)
    io.emit(`done:${torrent.infoHash}`, {
      files: torrent.files.map((f: TorrentFile) => ({
        name: f.name,
        url: `/download/${encodeURIComponent(torrent.name)}/${encodeURIComponent(f.name)}`,
        size: f.length,
      }))
    })
  })

  torrent.on('error', (err) => {
    console.error('Torrent error:', err)
    io.emit(`error:${torrent.infoHash}`, { error: err instanceof Error ? err.message : String(err) })
  })
}

function addTorrent(source: string, res: any) {
  try {
    const immediateHash = parseMagnetHash(source)

    // Prevent duplicate
    const existing = client.torrents.find(
      t => t.infoHash === immediateHash || t.magnetURI === source
    )
    if (existing) {
      res.json({ id: existing.infoHash, name: existing.name || existing.infoHash })
      return
    }

    if (immediateHash) {
      // Respond right away so the client can register socket listeners before
      // metadata arrives. The infoHash is stable and won't change.
      res.json({ id: immediateHash, name: immediateHash })

      const metaTimeout = setTimeout(() => {
        console.error(`Metadata timeout for ${immediateHash}`)
        io.emit(`error:${immediateHash}`, { error: 'Timed out fetching metadata — torrent may be dead or network is blocking peer connections.' })
        client.remove(immediateHash)
      }, 60_000)

      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        clearTimeout(metaTimeout)
        console.log(`Downloading: ${torrent.name} → ${DOWNLOAD_DIR}`)
        io.emit(`meta:${torrent.infoHash}`, { name: torrent.name })
        setupTorrentEvents(torrent)
      })
    } else {
      // .torrent file upload — infoHash only known after parsing, so wait for callback
      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        console.log(`Downloading: ${torrent.name} → ${DOWNLOAD_DIR}`)
        res.json({ id: torrent.infoHash, name: torrent.name })
        setupTorrentEvents(torrent)
      })
    }
  } catch (err) {
    console.error('addTorrent error:', err)
    res.status(500).json({ error: 'Failed to add torrent' })
  }
}

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`)
  console.log(`Saving downloads to: ${DOWNLOAD_DIR}`)
})