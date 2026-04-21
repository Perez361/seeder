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
import { google } from 'googleapis'

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

client.on('error', (err) => console.error('WebTorrent client error:', err))

// --- Google Drive ---

function getDrive() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set')
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(keyJson),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  })
  return google.drive({ version: 'v3', auth })
}

async function uploadToDrive(filePath: string, fileName: string): Promise<{ name: string; url: string; size: number }> {
  const drive = getDrive()
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID

  const stat = fs.statSync(filePath)

  const file = await drive.files.create({
    requestBody: {
      name: fileName,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { body: fs.createReadStream(filePath) },
    fields: 'id,size',
  })

  const fileId = file.data.id!

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  })

  return {
    name: fileName,
    url: `https://drive.google.com/uc?export=download&id=${fileId}`,
    size: stat.size,
  }
}

// --- Routes ---

app.use(express.json())

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
    files: driveFiles.get(t.infoHash) ?? [],
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

// --- Helpers ---

const driveFiles = new Map<string, { name: string; url: string; size: number }[]>()

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

  torrent.on('done', async () => {
    console.log(`Torrent done: ${torrent.name}`)
    io.emit(`uploading:${torrent.infoHash}`, {})

    try {
      const uploaded = await Promise.all(
        torrent.files.map(async (f: TorrentFile) => {
          const localPath = path.join(DOWNLOAD_DIR, torrent.name, f.name)
          console.log(`Uploading to Drive: ${f.name}`)
          const result = await uploadToDrive(localPath, f.name)
          fs.rmSync(localPath, { force: true })
          return result
        })
      )

      driveFiles.set(torrent.infoHash, uploaded)
      io.emit(`done:${torrent.infoHash}`, { files: uploaded })
      console.log(`All files uploaded to Drive for: ${torrent.name}`)

      // Clean up torrent folder
      const torrentDir = path.join(DOWNLOAD_DIR, torrent.name)
      fs.rmSync(torrentDir, { recursive: true, force: true })
    } catch (err) {
      console.error('Drive upload error:', err)
      const message = err instanceof Error ? err.message : String(err)
      io.emit(`error:${torrent.infoHash}`, { error: `Drive upload failed: ${message}` })
    }
  })

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
        console.log(`Downloading: ${torrent.name}`)
        io.emit(`meta:${torrent.infoHash}`, { name: torrent.name })
        setupTorrentEvents(torrent)
      })
    } else {
      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
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
})
