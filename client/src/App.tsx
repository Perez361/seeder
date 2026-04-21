import { useState, useRef } from 'react'
import { io } from 'socket.io-client'

const socket = io('http://localhost:3001')

type TorrentFile = { name: string; url: string; size: number }
type Progress = { progress: number; downloadSpeed: number; done: boolean }
type TorrentEntry = { name: string; progress: Progress; files: TorrentFile[]; error?: string }

export default function App() {
  const [torrents, setTorrents] = useState<Record<string, TorrentEntry>>({})
  const [magnet, setMagnet] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const uploadTorrent = async (file: File) => {
    const form = new FormData()
    form.append('torrent', file)
    const res = await fetch('/api/torrent/upload', { method: 'POST', body: form })
    const { id, name } = await res.json()
    registerTorrent(id, name)
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
    } catch (err) {
      console.error('Failed to add magnet:', err)
    } finally {
      setLoading(false)
    }
  }

  const registerTorrent = (id: string, name: string) => {
    setTorrents(prev => ({
      ...prev,
      [id]: { name, progress: { progress: 0, downloadSpeed: 0, done: false }, files: [] }
    }))

    socket.on(`meta:${id}`, ({ name: realName }: { name: string }) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], name: realName } }))
    })

    socket.on(`progress:${id}`, (data: Progress) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], progress: data } }))
    })

    socket.on(`done:${id}`, ({ files }: { files: TorrentFile[] }) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], files } }))
    })

    socket.on(`error:${id}`, ({ error }: { error: string }) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], error } }))
    })
  }

  return (
    <div style={{ maxWidth: 700, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>🌱 My Torrent Downloader</h1>

      {/* Upload .torrent file */}
      <input ref={fileRef} type="file" accept=".torrent" style={{ display: 'none' }}
        onChange={e => e.target.files?.[0] && uploadTorrent(e.target.files[0])} />
      <button onClick={() => fileRef.current?.click()}>Upload .torrent file</button>

      {/* Magnet link */}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <input
          value={magnet}
          onChange={e => setMagnet(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addMagnet()}
          placeholder="Paste magnet link..."
          style={{ flex: 1, padding: '6px 10px' }}
        />
        <button onClick={addMagnet} disabled={loading}>
          {loading ? 'Adding...' : 'Add'}
        </button>
      </div>

      {/* Torrent list */}
      {Object.entries(torrents).map(([id, t]) => (
        <div key={id} style={{ border: '1px solid #ccc', padding: 16, marginTop: 16, borderRadius: 8 }}>
          <strong>{t.name}</strong>
          <div style={{ marginTop: 8 }}>Progress: {t.progress.progress}%</div>
          <div style={{ background: '#eee', borderRadius: 4, height: 8, margin: '8px 0' }}>
            <div style={{ background: '#4caf50', width: `${t.progress.progress}%`, height: '100%', borderRadius: 4, transition: 'width 0.5s' }} />
          </div>
          <div>Speed: {(t.progress.downloadSpeed / 1024).toFixed(1)} KB/s</div>
          <div style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
            Saving to: C:\Users\Docile\Downloads
          </div>
          {t.error && (
            <div style={{ color: 'red', marginTop: 8 }}>Error: {t.error}</div>
          )}
          {t.progress.done && t.files.length === 0 && (
            <div style={{ color: 'green', marginTop: 8 }}>Download complete! Check your Downloads folder.</div>
          )}
          {t.files.map(f => (
            <a key={f.name} href={`http://localhost:3001${f.url}`} download
              style={{ display: 'block', marginTop: 8, color: '#1a73e8' }}>
              ⬇ {f.name} ({(f.size / 1024 / 1024).toFixed(1)} MB)
            </a>
          ))}
        </div>
      ))}
    </div>
  )
}