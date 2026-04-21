import { useState, useRef, useEffect } from 'react'
import { io } from 'socket.io-client'

const socket = io()

type TorrentFile = { name: string; size: number; url: string }
type Progress = { progress: number; downloadSpeed: number; done: boolean; numPeers?: number }
type ActiveTorrent = { id: string; name: string; meta: boolean; progress: Progress; files: TorrentFile[]; error?: string }
type StoredEntry = { id: string; torrentName: string; addedAt: string; totalSize: number; files: TorrentFile[] }

function fmt(bytes: number) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  return (bytes / 1e3).toFixed(0) + ' KB'
}

function isVideo(name: string) { return /\.(mp4|mkv|avi|mov|webm|m4v)$/i.test(name) }
function isAudio(name: string) { return /\.(mp3|flac|aac|wav|ogg|m4a)$/i.test(name) }

function MediaPlayer({ file, onClose }: { file: TorrentFile; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '90%', maxWidth: 900 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fff', marginBottom: 8 }}>
          <span style={{ fontSize: 14 }}>{file.name}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>
        {isVideo(file.name)
          ? <video src={file.url} controls autoPlay style={{ width: '100%', borderRadius: 8, maxHeight: '80vh' }} />
          : <audio src={file.url} controls autoPlay style={{ width: '100%' }} />
        }
      </div>
    </div>
  )
}

function FileRow({ file, onPlay }: { file: TorrentFile; onPlay?: () => void }) {
  const playable = isVideo(file.name) || isAudio(file.name)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}>
      <span style={{ flex: 1, fontSize: 13 }}>
        {file.name} <span style={{ color: '#888' }}>({fmt(file.size)})</span>
      </span>
      {playable && onPlay && (
        <button onClick={onPlay}
          style={{ background: '#6200ea', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>
          Play
        </button>
      )}
      <a href={file.url} download={file.name} style={{ textDecoration: 'none' }}>
        <button style={{ background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}>
          Download
        </button>
      </a>
    </div>
  )
}

export default function App() {
  const [active, setActive] = useState<Record<string, ActiveTorrent>>({})
  const [library, setLibrary] = useState<StoredEntry[]>([])
  const [magnet, setMagnet] = useState('')
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState<TorrentFile | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Restore active torrents
    fetch('/api/torrents').then(r => r.json()).then((list: any[]) => {
      setActive(prev => {
        const next = { ...prev }
        list.forEach(t => {
          next[t.id] = { id: t.id, name: t.name, meta: true, progress: { progress: t.progress, downloadSpeed: t.downloadSpeed, numPeers: t.numPeers, done: t.done }, files: t.files }
          subscribeToTorrent(t.id)
        })
        return next
      })
    })
    // Load file library
    fetch('/api/files').then(r => r.json()).then((entries: StoredEntry[]) => {
      setLibrary(entries.sort((a, b) => b.addedAt.localeCompare(a.addedAt)))
    })
  }, [])

  function subscribeToTorrent(id: string) {
    socket.on(`meta:${id}`, ({ name, files }: { name: string; files: TorrentFile[] }) =>
      setActive(prev => ({ ...prev, [id]: { ...prev[id], name, meta: true, files } })))
    socket.on(`progress:${id}`, (data: Progress) =>
      setActive(prev => ({ ...prev, [id]: { ...prev[id], progress: data } })))
    socket.on(`stored:${id}`, ({ entry, files }: { entry: StoredEntry; files: TorrentFile[] }) => {
      // Move from active to library
      setLibrary(prev => [{ ...entry, files }, ...prev.filter(e => e.id !== entry.id)])
      setActive(prev => { const next = { ...prev }; delete next[id]; return next })
    })
    socket.on(`error:${id}`, ({ error }: { error: string }) =>
      setActive(prev => ({ ...prev, [id]: { ...prev[id], error } })))
  }

  const registerTorrent = (id: string, name: string) => {
    setActive(prev => ({
      ...prev,
      [id]: { id, name, meta: false, progress: { progress: 0, downloadSpeed: 0, done: false }, files: [] }
    }))
    subscribeToTorrent(id)
  }

  const addMagnet = async () => {
    if (!magnet.trim() || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/torrent/magnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet })
      })
      const { id, name } = await res.json()
      registerTorrent(id, name)
      setMagnet('')
    } finally {
      setLoading(false)
    }
  }

  const uploadTorrent = async (file: File) => {
    const form = new FormData()
    form.append('torrent', file)
    const res = await fetch('/api/torrent/upload', { method: 'POST', body: form })
    const { id, name } = await res.json()
    registerTorrent(id, name)
  }

  const deleteEntry = async (id: string) => {
    await fetch(`/api/files/${id}`, { method: 'DELETE' })
    setLibrary(prev => prev.filter(e => e.id !== id))
  }

  return (
    <div style={{ maxWidth: 750, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      {playing && <MediaPlayer file={playing} onClose={() => setPlaying(null)} />}

      <h1 style={{ marginBottom: 24 }}>🌱 Seeder</h1>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={magnet}
          onChange={e => setMagnet(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addMagnet()}
          placeholder="Paste magnet link..."
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
        />
        <button onClick={addMagnet} disabled={loading}
          style={{ background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', cursor: 'pointer', fontWeight: 600 }}>
          {loading ? 'Adding...' : 'Add'}
        </button>
        <input ref={fileRef} type="file" accept=".torrent" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && uploadTorrent(e.target.files[0])} />
        <button onClick={() => fileRef.current?.click()}
          style={{ border: '1px solid #ccc', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', background: '#fff' }}>
          .torrent file
        </button>
      </div>

      {/* Active downloads */}
      {Object.values(active).length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Downloading</h2>
          {Object.values(active).map(t => (
            <div key={t.id} style={{ border: '1px solid #e0e0e0', borderRadius: 10, padding: 16, marginBottom: 12 }}>
              <div style={{ fontWeight: 600 }}>{t.meta ? t.name : 'Fetching metadata...'}</div>
              {!t.meta && !t.error && <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>Connecting to peers...</div>}
              {t.meta && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#555', margin: '8px 0 4px' }}>
                    <span>{t.progress.progress}%</span>
                    <span>{fmt(t.progress.downloadSpeed * 1024)}/s · {t.progress.numPeers ?? 0} peers</span>
                  </div>
                  <div style={{ background: '#e0e0e0', borderRadius: 4, height: 6 }}>
                    <div style={{ background: '#1a73e8', width: `${t.progress.progress}%`, height: '100%', borderRadius: 4, transition: 'width 0.5s' }} />
                  </div>
                  {t.files.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Available now — stream while downloading:</div>
                      {t.files.map(f => (
                        <FileRow key={f.name} file={f}
                          onPlay={(isVideo(f.name) || isAudio(f.name)) ? () => setPlaying(f) : undefined} />
                      ))}
                    </div>
                  )}
                </>
              )}
              {t.error && <div style={{ color: 'red', fontSize: 13, marginTop: 8 }}>{t.error}</div>}
            </div>
          ))}
        </section>
      )}

      {/* File library */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          My Files {library.length > 0 && <span style={{ fontWeight: 400, color: '#888', fontSize: 14 }}>({library.length})</span>}
        </h2>
        {library.length === 0
          ? <div style={{ color: '#aaa', fontSize: 14 }}>No files yet. Add a magnet link above.</div>
          : library.map(entry => (
            <div key={entry.id} style={{ border: '1px solid #e0e0e0', borderRadius: 10, padding: 16, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{entry.torrentName}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                    {fmt(entry.totalSize)} · {new Date(entry.addedAt).toLocaleDateString()}
                  </div>
                </div>
                <button onClick={() => deleteEntry(entry.id)}
                  style={{ background: 'none', border: 'none', color: '#d32f2f', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
                  title="Delete">🗑</button>
              </div>
              <div style={{ marginTop: 8 }}>
                {entry.files.map(f => (
                  <FileRow key={f.name} file={f}
                    onPlay={(isVideo(f.name) || isAudio(f.name)) ? () => setPlaying(f) : undefined} />
                ))}
              </div>
            </div>
          ))
        }
      </section>
    </div>
  )
}
