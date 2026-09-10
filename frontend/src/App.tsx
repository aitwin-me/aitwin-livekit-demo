import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  AiTwin,
  type AiTwinHandle,
} from '@streamoji/aitwin'
import {
  Room,
  Track,
  createLocalAudioTrack,
  type LocalAudioTrack,
} from 'livekit-client'

type TextMode = 'chat' | 'say'

function requireViteEnv(name: 'VITE_TOPIC_CHAT' | 'VITE_TOPIC_SPEAK'): string {
  const value = (import.meta.env[name] as string | undefined)?.trim()
  if (!value) {
    throw new Error(`Missing ${name} — set it in frontend/.env`)
  }
  return value
}

const TOPIC_CHAT = requireViteEnv('VITE_TOPIC_CHAT')
const TOPIC_SPEAK = requireViteEnv('VITE_TOPIC_SPEAK')

type ConnectPayload = {
  url: string
  token: string
  roomName: string
  aitwinAuthToken: string
  aitwinTwinId: string
  aitwinApiBase: string
}

export default function App() {
  const twinRef = useRef<AiTwinHandle | null>(null)
  const roomRef = useRef<Room | null>(null)
  const micTrackRef = useRef<LocalAudioTrack | null>(null)
  const speakingRef = useRef(false)
  const queueRef = useRef<string[]>([])
  const twinReadyRef = useRef(false)

  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [twinReady, setTwinReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roomName, setRoomName] = useState<string | null>(null)
  const [lastHeard, setLastHeard] = useState<string | null>(null)
  const [lastAgentText, setLastAgentText] = useState<string | null>(null)
  const [queuedCount, setQueuedCount] = useState(0)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<TextMode>('chat')
  const [sending, setSending] = useState(false)
  const [micEnabled, setMicEnabled] = useState(false)
  const [auth, setAuth] = useState<{
    authToken: string
    twinId: string
    apiBase: string
  } | null>(null)

  // Keep a stable drain loop that always reads current readiness via refs
  // (text-stream handlers capture callbacks from connect-time otherwise).
  const speakQueued = useCallback(async () => {
    if (speakingRef.current) return
    const twin = twinRef.current
    if (!twin || !twinReadyRef.current) return

    const next = queueRef.current.shift()
    if (!next) {
      setQueuedCount(0)
      return
    }
    setQueuedCount(queueRef.current.length)

    speakingRef.current = true
    setLastHeard(next)
    try {
      console.log('[AiTwin] speakText', next.slice(0, 120))
      await twin.speakText(next)
    } catch (err) {
      console.error('[AiTwin] speakText failed', err)
      setError(err instanceof Error ? err.message : 'speakText failed')
    } finally {
      speakingRef.current = false
      if (queueRef.current.length) {
        void speakQueued()
      } else {
        setQueuedCount(0)
      }
    }
  }, [])

  const enqueueSpeak = useCallback(
    (text: string, source: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      console.log(`[enqueue:${source}]`, trimmed.slice(0, 120))
      setLastAgentText(trimmed)
      queueRef.current.push(trimmed)
      setQueuedCount(queueRef.current.length)
      void speakQueued()
    },
    [speakQueued],
  )

  useEffect(() => {
    twinReadyRef.current = twinReady
    if (twinReady) void speakQueued()
  }, [twinReady, speakQueued])

  const disconnect = useCallback(async () => {
    queueRef.current = []
    speakingRef.current = false
    twinReadyRef.current = false

    const mic = micTrackRef.current
    micTrackRef.current = null
    if (mic) {
      mic.stop()
      try {
        await roomRef.current?.localParticipant.unpublishTrack(mic)
      } catch {
        /* ignore */
      }
    }

    const room = roomRef.current
    roomRef.current = null
    if (room) {
      await room.disconnect()
    }

    setMicEnabled(false)
    setStatus('idle')
    setRoomName(null)
    setDraft('')
    setLastHeard(null)
    setLastAgentText(null)
    setQueuedCount(0)
    setAuth(null)
    setTwinReady(false)
  }, [])

  useEffect(() => {
    return () => {
      void disconnect()
    }
  }, [disconnect])

  const attachTextHandlers = useCallback(
    (room: Room) => {
      // TTS must come only from aitwin.speak. lk.transcription is also published by
      // RoomIO during LLM generation; listening to both caused partial-then-full double speak.
      room.registerTextStreamHandler(TOPIC_SPEAK, (reader, participantInfo) => {
        void (async () => {
          try {
            const text = (await reader.readAll()).trim()
            if (!text) return
            if (participantInfo.identity === room.localParticipant.identity) {
              console.log('[skip local aitwin.speak]', text.slice(0, 80))
              return
            }
            enqueueSpeak(text, `${TOPIC_SPEAK}:${participantInfo.identity}`)
          } catch (err) {
            console.warn(`${TOPIC_SPEAK} stream failed`, err)
          }
        })()
      })
    },
    [enqueueSpeak],
  )

  const connect = useCallback(async () => {
    setError(null)
    setStatus('connecting')

    try {
      await disconnect()

      const response = await fetch('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: `aitwin-demo-${Date.now()}` }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `Token request failed (${response.status})`)
      }

      const data = (await response.json()) as ConnectPayload & { aitwinError?: string }
      if (!data.aitwinAuthToken) {
        throw new Error(
          data.aitwinError ||
            'AiTwin auth token missing — set AITWIN_CLIENT_ID / AITWIN_CLIENT_SECRET on the token server',
        )
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      })
      attachTextHandlers(room)

      await room.connect(data.url, data.token)
      roomRef.current = room

      setAuth({
        authToken: data.aitwinAuthToken,
        twinId: data.aitwinTwinId || 'victoria',
        apiBase: data.aitwinApiBase || 'https://ai.aitwin.me',
      })
      setRoomName(data.roomName)
      setStatus('connected')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed'
      console.error(err)
      setError(message)
      setStatus('error')
    }
  }, [attachTextHandlers, disconnect])

  const toggleMic = useCallback(async () => {
    const room = roomRef.current
    if (!room || status !== 'connected') return

    setError(null)
    try {
      if (micEnabled) {
        const mic = micTrackRef.current
        micTrackRef.current = null
        if (mic) {
          await room.localParticipant.unpublishTrack(mic)
          mic.stop()
        }
        setMicEnabled(false)
        return
      }

      const track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
      })
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
      })
      micTrackRef.current = track
      setMicEnabled(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone failed'
      console.error(err)
      setError(message)
    }
  }, [micEnabled, status])

  const onSubmitText = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const text = draft.trim()
      const room = roomRef.current
      if (!text || !room || sending) return

      setSending(true)
      setError(null)
      try {
        if (mode === 'say') {
          if (!twinReadyRef.current) {
            throw new Error('Twin is not ready yet — wait for the avatar to finish loading')
          }
          enqueueSpeak(text, 'local-say')
        } else {
          await room.localParticipant.sendText(text, { topic: TOPIC_CHAT })
        }
        setDraft('')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to send text'
        console.error(err)
        setError(message)
      } finally {
        setSending(false)
      }
    },
    [draft, enqueueSpeak, mode, sending],
  )

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">AiTwin × LiveKit Agents</p>
          <h1>STT → LLM → text → AiTwin TTS</h1>
          <p className="lede">
            LiveKit handles realtime conversation (mic STT + LLM). Agent audio is off;
            AiTwin owns voice generation and avatar animation.
          </p>
        </div>
        <div className="actions">
          {status !== 'connected' ? (
            <button type="button" onClick={() => void connect()} disabled={status === 'connecting'}>
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      <main className="stage">
        <div className="avatar-shell">
          <div className="avatar-container">
            {auth ? (
              <AiTwin
                key={auth.authToken}
                ref={twinRef}
                id={auth.twinId}
                authToken={auth.authToken}
                apiBase={auth.apiBase}
                onReady={() => {
                  console.log('[AiTwin] ready')
                  twinReadyRef.current = true
                  setTwinReady(true)
                }}
                onError={(message) => {
                  console.error('[AiTwin]', message)
                  setError(message)
                }}
                showErrorOverlay={false}
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  lineHeight: 0,
                }}
                canvasStyle={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                }}
              />
            ) : (
              <div className="avatar-placeholder">Connect to load the AiTwin avatar</div>
            )}
          </div>
        </div>

        <aside className="panel">
          <p>
            <strong>Status:</strong> {status}
            {twinReady ? ' · twin ready' : auth ? ' · loading twin…' : ''}
            {queuedCount > 0 ? ` · queued ${queuedCount}` : ''}
          </p>
          {roomName && (
            <p>
              <strong>Room:</strong> {roomName}
            </p>
          )}
          {lastAgentText && (
            <p className="heard">
              <strong>Agent text:</strong> {lastAgentText}
            </p>
          )}
          {lastHeard && (
            <p className="heard">
              <strong>Speaking:</strong> {lastHeard}
            </p>
          )}
          {error && <p className="error">{error}</p>}

          {status === 'connected' ? (
            <>
              <button
                type="button"
                className={micEnabled ? 'mic on' : 'mic'}
                onClick={() => void toggleMic()}
              >
                {micEnabled ? 'Mic on — tap to mute' : 'Enable mic (STT)'}
              </button>

              <form className="text-form" onSubmit={(e) => void onSubmitText(e)}>
                <div className="mode-row" role="group" aria-label="Text mode">
                  <button
                    type="button"
                    className={mode === 'chat' ? 'mode active' : 'mode'}
                    onClick={() => setMode('chat')}
                  >
                    Chat (LLM)
                  </button>
                  <button
                    type="button"
                    className={mode === 'say' ? 'mode active' : 'mode'}
                    onClick={() => setMode('say')}
                  >
                    Speak text
                  </button>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    mode === 'say'
                      ? 'Exact words for AiTwin to speak…'
                      : 'Ask the agent something…'
                  }
                  rows={3}
                />
                <button type="submit" disabled={sending || !draft.trim()}>
                  {sending ? 'Sending…' : mode === 'say' ? 'Speak' : 'Send chat'}
                </button>
                <p className="hint">
                  {mode === 'say'
                    ? 'Speak text → AiTwin TTS only (no LLM).'
                    : 'Chat → LiveKit LLM → aitwin.speak → AiTwin TTS.'}
                </p>
              </form>
            </>
          ) : (
            <p className="hint">Connect, then use mic and/or chat. Agent never publishes audio.</p>
          )}

          <ol>
            <li>Connect (LiveKit room + AiTwin auth)</li>
            <li>
              <strong>Mic</strong> → STT → LLM → text, or <strong>Chat</strong> for typed turns
            </li>
            <li>AiTwin speaks agent text via <code>speakText</code></li>
          </ol>
        </aside>
      </main>
    </div>
  )
}
