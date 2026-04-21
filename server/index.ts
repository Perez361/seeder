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
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'seeder-downloads')

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const client = new WebTorrent()
const upload = multer({ dest: os.tmpdir() })

client.on('error', (err) => console.error('WebTorrent error:', err))

app.use(express.json())

// Stream a file directly from WebTorrent to the browser.
// Works even while the torrent is still downloading.
app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const torrent = client.get(req.params.infoHash) as Torrent | null
  if (!torrent) { res.status(404).send('Torrent not found'); return }

  const fileIndex = parseInt(req.params.fileIndex)
  const file = torrent.files[fileIndex] as TorrentFile | undefined
  if (!file) { res.status(404).send('File not found'); return }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')

  const rangeHeader = req.headers.range
  if (rangeHeader) {
    const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-')
    const start = parseInt(startStr) || 0
    const end = endStr ? parseInt(endStr) : file.length - 1
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`)
    res.setHeader('Content-Length', end - start + 1)
    res.status(206)
    file.createReadStream({ start, end }).pipe(res)
  } else {
    res.setHeader('Content-Length', file.length)
    file.createReadStream().pipe(res)
  }
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
    files: t.files.map((f: TorrentFile, i: number) => ({
      name: f.name,
      url: `/stream/${t.infoHash}/${i}`,
      size: f.length,
    })),
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

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'https://tracker.opentrackr.org/announce',
  'https://tracker.gbitt.info/announce',
  'https://tracker.tamersunion.org/announce',
]

function injectTrackers(magnet: string): string {
  return magnet + PUBLIC_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')
}

function parseMagnetHash(magnet: string): string | null {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

function torrentFiles(torrent: Torrent) {
  return torrent.files.map((f: TorrentFile, i: number) => ({
    name: f.name,
    url: `/stream/${torrent.infoHash}/${i}`,
    size: f.length,
  }))
}

function setupTorrentEvents(torrent: Torrent) {
  const interval = setInterval(() => {
    io.emit(`progress:${torrent.infoHash}`, {
      progress: Math.round(torrent.progress * 100),
      downloadSpeed: torrent.downloadSpeed,
      done: torrent.done,
      numPeers: torrent.numPeers,
    })
    if (torrent.done) clearInterval(interval)
  }, 1000)

  torrent.on('error', (err) => {
    console.error('Torrent error:', err)
    io.emit(`error:${torrent.infoHash}`, { error: err instanceof Error ? err.message : String(err) })
  })
}

function addTorrent(source: string, res: any) {
  try {
    const immediateHash = parseMagnetHash(source)

    const existing = client.torrents.find(
      t => t.infoHash === immediateHash || t.magnetURI === source
    )
    if (existing) {
      res.json({ id: existing.infoHash, name: existing.name || existing.infoHash })
      return
    }

    if (immediateHash) {
      res.json({ id: immediateHash, name: immediateHash })

      const metaTimeout = setTimeout(() => {
        io.emit(`error:${immediateHash}`, { error: 'Timed out — torrent may be dead or unreachable.' })
        client.remove(immediateHash)
      }, 60_000)

      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        clearTimeout(metaTimeout)
        console.log(`Ready: ${torrent.name} (${torrent.files.length} files)`)
        // Emit name + full file list immediately — user can start downloading right away
        io.emit(`meta:${torrent.infoHash}`, { name: torrent.name, files: torrentFiles(torrent) })
        setupTorrentEvents(torrent)
      })
    } else {
      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        res.json({ id: torrent.infoHash, name: torrent.name })
        io.emit(`meta:${torrent.infoHash}`, { name: torrent.name, files: torrentFiles(torrent) })
        setupTorrentEvents(torrent)
      })
    }
  } catch (err) {
    console.error('addTorrent error:', err)
    res.status(500).json({ error: 'Failed to add torrent' })
  }
}

server.listen(PORT, () => console.log(`Server running on :${PORT}`))
