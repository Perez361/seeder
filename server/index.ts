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
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001
const CLIENT_DIST = path.join(__dirname, '../../client/dist')

// STORAGE_DIR: set to /data (Railway volume) in production for persistence.
// Falls back to a local folder for development.
const STORAGE_DIR = process.env.STORAGE_DIR ?? path.join(os.homedir(), 'seeder-storage')
const DOWNLOAD_DIR = path.join(STORAGE_DIR, 'downloading')  // active torrent temp space
const FILES_DIR    = path.join(STORAGE_DIR, 'files')        // permanent completed files
const META_FILE    = path.join(STORAGE_DIR, 'metadata.json')

for (const dir of [DOWNLOAD_DIR, FILES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// --- Cloudflare R2 ---
// Set these env vars in Railway to enable persistent storage.
// Without them the app still works but files are lost on container restart.
const R2_ENABLED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
)

const r2 = R2_ENABLED ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
}) : null

async function uploadToR2(localPath: string, key: string, size: number): Promise<string> {
  await r2!.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentLength: size,
  }))
  return `${process.env.R2_PUBLIC_URL}/${key}`
}

async function deleteFromR2(key: string) {
  await r2!.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
  }))
}

// --- Metadata store ---
// When R2 is enabled, metadata.json is also stored in R2 so it survives restarts.
type StoredFile = { name: string; size: number; url: string; r2Key?: string }
type StoredEntry = { id: string; torrentName: string; addedAt: string; totalSize: number; files: StoredFile[] }

const META_KEY = 'metadata.json'

async function readMeta(): Promise<StoredEntry[]> {
  // Try local file first (fast path)
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) } catch { return [] }
}

async function writeMeta(entries: StoredEntry[]) {
  const json = JSON.stringify(entries, null, 2)
  fs.writeFileSync(META_FILE, json)
  // Mirror to R2 so it survives restarts
  if (R2_ENABLED) {
    const tmp = META_FILE + '.tmp'
    fs.writeFileSync(tmp, json)
    await uploadToR2(tmp, META_KEY, Buffer.byteLength(json)).catch(console.error)
    fs.rmSync(tmp, { force: true })
  }
}

async function loadMetaFromR2() {
  if (!R2_ENABLED) return
  try {
    // Fetch metadata.json from R2 public URL on startup to restore library
    const url = `${process.env.R2_PUBLIC_URL}/${META_KEY}`
    const res = await fetch(url)
    if (!res.ok) return
    const entries: StoredEntry[] = await res.json()
    fs.writeFileSync(META_FILE, JSON.stringify(entries, null, 2))
    console.log(`Restored ${entries.length} library entries from R2`)
  } catch { /* first run, no metadata yet */ }
}

async function addMeta(entry: StoredEntry) {
  const entries = (await readMeta()).filter(e => e.id !== entry.id)
  await writeMeta([...entries, entry])
}

async function deleteMeta(id: string) {
  await writeMeta((await readMeta()).filter(e => e.id !== id))
}

// --- App setup ---
const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const client = new WebTorrent()
const upload = multer({ dest: DOWNLOAD_DIR })

client.on('error', (err) => console.error('WebTorrent error:', err))
app.use(express.json())

// --- Streaming ---

// Stream an active (in-progress) torrent file directly from WebTorrent
app.get('/stream/active/:infoHash/:fileIndex', (req, res) => {
  const torrent = client.torrents.find((t: Torrent) => t.infoHash === req.params.infoHash) ?? null
  if (!torrent) { res.status(404).send('Torrent not found'); return }
  const file = torrent.files[parseInt(req.params.fileIndex)] as TorrentFile | undefined
  if (!file) { res.status(404).send('File not found'); return }
  streamFile(res, req.headers.range, file.length, file.name,
    (opts) => file.createReadStream(opts))
})

// Serve a completed file from local storage (fallback when R2 not configured)
app.get('/stream/stored/:id/:filename', async (req, res) => {
  const entries = await readMeta()
  const entry = entries.find(e => e.id === req.params.id)
  if (!entry) { res.status(404).send('Not found'); return }
  const stored = entry.files.find(f => f.name === decodeURIComponent(req.params.filename))
  if (!stored) { res.status(404).send('File not found'); return }
  const filePath = path.join(FILES_DIR, entry.id, stored.name)
  if (!fs.existsSync(filePath)) { res.status(404).send('File missing on disk'); return }
  streamFile(res, req.headers.range, stored.size, stored.name,
    (opts) => fs.createReadStream(filePath, opts ?? {}))
})

function streamFile(
  res: express.Response,
  rangeHeader: string | undefined,
  size: number,
  name: string,
  makeStream: (opts?: { start: number; end: number }) => NodeJS.ReadableStream
) {
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')

  if (rangeHeader) {
    const [s, e] = rangeHeader.replace(/bytes=/, '').split('-')
    const start = parseInt(s) || 0
    const end = e ? parseInt(e) : size - 1
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', end - start + 1)
    res.status(206)
    makeStream({ start, end }).pipe(res)
  } else {
    res.setHeader('Content-Length', size)
    makeStream().pipe(res)
  }
}

// --- API ---

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST))
  app.get('/*splat', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')))
}

// Active torrents (in progress)
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
      size: f.length,
      url: `/stream/active/${t.infoHash}/${i}`,
    })),
  })))
})

// Completed file library
app.get('/api/files', async (_req, res) => {
  res.json(await readMeta())
})

// Delete a stored entry and its files
app.delete('/api/files/:id', async (req, res) => {
  const entries = await readMeta()
  const entry = entries.find(e => e.id === req.params.id)
  if (!entry) { res.status(404).json({ error: 'Not found' }); return }
  // Delete from R2
  if (R2_ENABLED) {
    await Promise.all(entry.files.map(f => f.r2Key ? deleteFromR2(f.r2Key) : Promise.resolve()))
  }
  // Delete local copies if any remain
  const torrentDir = path.join(FILES_DIR, entry.id)
  if (fs.existsSync(torrentDir)) fs.rmSync(torrentDir, { recursive: true, force: true })
  await deleteMeta(entry.id)
  res.json({ ok: true })
})

app.post('/api/torrent/upload', upload.single('torrent'), (req, res) => {
  if (!req.file?.path) { res.status(400).json({ error: 'No file' }); return }
  addTorrent(req.file.path, res)
})

app.post('/api/torrent/magnet', (req, res) => {
  const { magnet } = req.body
  if (!magnet) { res.status(400).json({ error: 'No magnet' }); return }
  addTorrent(injectTrackers(magnet), res)
})

// --- Torrent logic ---

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

function activeTorrentFiles(torrent: Torrent) {
  return torrent.files.map((f: TorrentFile, i: number) => ({
    name: f.name,
    size: f.length,
    url: `/stream/active/${torrent.infoHash}/${i}`,
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

  torrent.on('done', async () => {
    console.log(`Done downloading: ${torrent.name}`)
    const storedFiles: StoredFile[] = []

    for (const f of torrent.files as TorrentFile[]) {
      const src = path.join(DOWNLOAD_DIR, torrent.name, f.name)
      if (!fs.existsSync(src)) continue

      let url: string
      let r2Key: string | undefined

      if (R2_ENABLED) {
        r2Key = `${torrent.infoHash}/${f.name}`
        console.log(`Uploading to R2: ${f.name}`)
        url = await uploadToR2(src, r2Key, f.length)
        fs.rmSync(src, { force: true })
      } else {
        // No R2 — keep file on disk and serve locally
        const destDir = path.join(FILES_DIR, torrent.infoHash)
        fs.mkdirSync(destDir, { recursive: true })
        fs.renameSync(src, path.join(destDir, f.name))
        url = `/stream/stored/${torrent.infoHash}/${encodeURIComponent(f.name)}`
      }

      storedFiles.push({ name: f.name, size: f.length, url, r2Key })
    }

    const entry: StoredEntry = {
      id: torrent.infoHash,
      torrentName: torrent.name,
      addedAt: new Date().toISOString(),
      totalSize: storedFiles.reduce((s, f) => s + f.size, 0),
      files: storedFiles,
    }
    await addMeta(entry)

    const clientFiles = storedFiles.map(f => ({ name: f.name, size: f.size, url: f.url }))
    io.emit(`stored:${torrent.infoHash}`, { entry: { ...entry, files: clientFiles }, files: clientFiles })
    console.log(`Done: ${torrent.name} → ${R2_ENABLED ? 'R2' : 'local disk'}`)
  })

  torrent.on('error', (err) => {
    io.emit(`error:${torrent.infoHash}`, { error: err instanceof Error ? err.message : String(err) })
  })
}

function addTorrent(source: string, res: any) {
  try {
    const immediateHash = parseMagnetHash(source)
    const existing = client.torrents.find(t => t.infoHash === immediateHash || t.magnetURI === source)
    if (existing) {
      res.json({ id: existing.infoHash, name: existing.name || existing.infoHash })
      return
    }

    if (immediateHash) {
      res.json({ id: immediateHash, name: immediateHash })
      const metaTimeout = setTimeout(() => {
        io.emit(`error:${immediateHash}`, { error: 'Timed out — torrent may be dead.' })
        client.remove(immediateHash)
      }, 60_000)

      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        clearTimeout(metaTimeout)
        console.log(`Metadata ready: ${torrent.name}`)
        io.emit(`meta:${torrent.infoHash}`, {
          name: torrent.name,
          files: activeTorrentFiles(torrent),
        })
        setupTorrentEvents(torrent)
      })
    } else {
      client.add(source, { path: DOWNLOAD_DIR }, (torrent: Torrent) => {
        res.json({ id: torrent.infoHash, name: torrent.name })
        io.emit(`meta:${torrent.infoHash}`, {
          name: torrent.name,
          files: activeTorrentFiles(torrent),
        })
        setupTorrentEvents(torrent)
      })
    }
  } catch (err) {
    console.error('addTorrent error:', err)
    res.status(500).json({ error: 'Failed to add torrent' })
  }
}

loadMetaFromR2().then(() => {
  server.listen(PORT, () =>
    console.log(`Server on :${PORT} | R2: ${R2_ENABLED ? 'enabled' : 'disabled (ephemeral)'}`)
  )
})
