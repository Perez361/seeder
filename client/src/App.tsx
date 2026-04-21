import { useState, useRef, useEffect } from 'react'
import { io } from 'socket.io-client'

const socket = io()

type TorrentFile = { name: string; url: string; size: number }
type Progress = { progress: number; downloadSpeed: number; done: boolean; numPeers?: number }
type TorrentEntry = { name: string; meta: boolean; progress: Progress; files: TorrentFile[]; error?: string }

export default function App() {
  const [torrents, setTorrents] = useState<Record<string, TorrentEntry>>({})
  const [magnet, setMagnet] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/torrents')
      .then(r => r.json())
      .then((list: { id: string; name: string; progress: number; downloadSpeed: number; numPeers: number; done: boolean; files: TorrentFile[] }[]) => {
        setTorrents(prev => {
          const next = { ...prev }
          list.forEach(t => {
            next[t.id] = {
              name: t.name,
              meta: true,
              progress: { progress: t.progress, downloadSpeed: t.downloadSpeed, numPeers: t.numPeers, done: t.done },
              files: t.files,
            }
          })
          return next
        })
        list.forEach(t => {
          socket.on(`meta:${t.id}`, ({ name, files }: { name: string; files: TorrentFile[] }) =>
            setTorrents(prev => ({ ...prev, [t.id]: { ...prev[t.id], name, meta: true, files } })))
          socket.on(`progress:${t.id}`, (data: Progress) =>
            setTorrents(prev => ({ ...prev, [t.id]: { ...prev[t.id], progress: data } })))
          socket.on(`error:${t.id}`, ({ error }: { error: string }) =>
            setTorrents(prev => ({ ...prev, [t.id]: { ...prev[t.id], error } })))
        })
      })
  }, [])

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
      [id]: { name, meta: false, progress: { progress: 0, downloadSpeed: 0, done: false }, files: [] }
    }))

    socket.on(`meta:${id}`, ({ name: realName, files }: { name: string; files: TorrentFile[] }) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], name: realName, meta: true, files } }))
    })

    socket.on(`progress:${id}`, (data: Progress) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], progress: data } }))
    })

    socket.on(`error:${id}`, ({ error }: { error: string }) => {
      setTorrents(prev => ({ ...prev, [id]: { ...prev[id], error } }))
    })
  }

  return (
    <div style={{ maxWidth: 700, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>🌱 My Torrent Downloader</h1>

      <input ref={fileRef} type="file" accept=".torrent" style={{ display: 'none' }}
        onChange={e => e.target.files?.[0] && uploadTorrent(e.target.files[0])} />
      <button onClick={() => fileRef.current?.click()}>Upload .torrent file</button>

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

      {Object.entries(torrents).map(([id, t]) => (
        <div key={id} style={{ border: '1px solid #ccc', padding: 16, marginTop: 16, borderRadius: 8 }}>
          <strong>{t.meta ? t.name : 'Fetching metadata...'}</strong>
          {!t.meta && !t.error && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#888' }}>Connecting to peers, please wait...</div>
          )}
          {t.meta && <>
            <div style={{ marginTop: 8 }}>Progress: {t.progress.progress}%</div>
            <div style={{ background: '#eee', borderRadius: 4, height: 8, margin: '8px 0' }}>
              <div style={{ background: '#4caf50', width: `${t.progress.progress}%`, height: '100%', borderRadius: 4, transition: 'width 0.5s' }} />
            </div>
            <div style={{ fontSize: 13, color: '#555' }}>
              Speed: {(t.progress.downloadSpeed / 1024).toFixed(1)} KB/s &nbsp;|&nbsp; Peers: {t.progress.numPeers ?? 0}
            </div>
          </>}
          {t.error && (
            <div style={{ color: 'red', marginTop: 8 }}>Error: {t.error}</div>
          )}
          {t.files.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>
                {t.progress.done ? 'Ready:' : 'Downloading — click to stream now:'}
              </strong>
              {t.files.map(f => (
                <div key={f.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6 }}>
                  <span style={{ fontSize: 13, marginRight: 12 }}>
                    {f.name} <span style={{ color: '#888' }}>({(f.size / 1024 / 1024).toFixed(1)} MB)</span>
                  </span>
                  <a href={f.url} download={f.name} style={{ textDecoration: 'none' }}>
                    <button style={{ background: '#1a73e8', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', cursor: 'pointer' }}>
                      Download
                    </button>
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
