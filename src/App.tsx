import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp,
  Mic,
  Volume2,
  VolumeX,
  Pin,
  PinOff,
  SquarePen,
  AlertCircle,
} from 'lucide-react';
import { LiveClient, type ConnectionStatus, type LiveEvent } from './agent/liveClient';
import type { AgentActivity } from './agent/screenAgent';
import { Orb } from './components/Orb';
import { ActivityRow } from './components/ActivityRow';

type ChatItem =
  | { id: string; kind: 'user' | 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'activity'; steps: AgentActivity[]; done: boolean }
  | { id: string; kind: 'notice'; text: string };

const SUGGESTIONS = [
  'Put my cursor on the Start button',
  'Point at the clock on my taskbar',
  'Click the browser address bar',
  'What can you do?',
];

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function appendText(items: ChatItem[], kind: 'user' | 'assistant', text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { id: uid(), kind, text: text.trimStart(), streaming: true }];
}

function addActivity(items: ChatItem[], activity: AgentActivity): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === 'activity' && !last.done) {
    return [...items.slice(0, -1), { ...last, steps: [...last.steps, activity] }];
  }
  // Close any streaming bubble so speech after the action starts a new one
  const closed = items.map((it) =>
    (it.kind === 'user' || it.kind === 'assistant') && it.streaming ? { ...it, streaming: false } : it
  );
  return [...closed, { id: uid(), kind: 'activity', steps: [activity], done: false }];
}

function finalize(items: ChatItem[]): ChatItem[] {
  return items.map((it) => {
    if ((it.kind === 'user' || it.kind === 'assistant') && it.streaming) return { ...it, streaming: false };
    if (it.kind === 'activity' && !it.done) return { ...it, done: true };
    return it;
  });
}

export default function App() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [micOn, setMicOn] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const clientRef = useRef<LiveClient | null>(null);

  const isElectron = Boolean(window.electronAPI?.isElectron);
  const platform = window.electronAPI?.platform ?? 'web';

  const pushNotice = useCallback((text: string) => {
    setItems((prev) => [...prev, { id: uid(), kind: 'notice', text }]);
  }, []);

  const handleEvent = useCallback(
    (e: LiveEvent) => {
      switch (e.type) {
        case 'status':
          setStatus(e.status);
          if (e.status === 'idle') setThinking(false);
          break;
        case 'user_transcript':
          setItems((prev) => appendText(prev, 'user', e.text));
          setThinking(true);
          break;
        case 'assistant_transcript':
          setItems((prev) => appendText(prev, 'assistant', e.text));
          setThinking(false);
          break;
        case 'activity':
          setItems((prev) => addActivity(prev, e.activity));
          setThinking(false);
          break;
        case 'turn_complete':
        case 'interrupted':
          setItems(finalize);
          setThinking(false);
          break;
        case 'mic':
          setMicOn(e.on);
          break;
        case 'error':
          pushNotice(e.message);
          setThinking(false);
          break;
      }
    },
    [pushNotice]
  );

  // Create the Live client once
  useEffect(() => {
    const client = new LiveClient(handleEvent);
    clientRef.current = client;
    return () => client.disconnect();
  }, [handleEvent]);

  // Backend sanity check
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        if (!h.hasApiKey) pushNotice('No Gemini API key found. Add GEMINI_API_KEY to your .env file and restart.');
      })
      .catch(() => pushNotice('Can’t reach the GridSight backend.'));
    if (!isElectron) pushNotice('Running in a browser — open the desktop app to let me control your mouse.');
  }, [isElectron, pushNotice]);

  // Audio-reactive visuals without re-rendering React every frame
  useEffect(() => {
    let raf = 0;
    let lastSpeaking = false;
    const tick = () => {
      const client = clientRef.current;
      const root = rootRef.current;
      if (client && root) {
        const mic = Math.min(1, client.getMicLevel() * 7);
        const out = Math.min(1, client.getOutputLevel() * 5);
        root.style.setProperty('--mic', mic.toFixed(3));
        root.style.setProperty('--out', out.toFixed(3));
        const s = client.isSpeaking;
        if (s !== lastSpeaking) {
          lastSpeaking = s;
          setSpeaking(s);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, thinking]);

  // Auto-grow composer
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [input]);

  const sendMessage = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || !clientRef.current) return;
    setInput('');
    setItems((prev) => [...finalize(prev), { id: uid(), kind: 'user', text, streaming: false }]);
    setThinking(true);
    try {
      await clientRef.current.sendText(text);
    } catch (err) {
      setThinking(false);
      pushNotice(err instanceof Error ? err.message : 'Message failed to send');
    }
  };

  const toggleMic = async () => {
    const client = clientRef.current;
    if (!client) return;
    if (client.micOn) {
      client.stopMic();
      return;
    }
    try {
      await client.startMic();
    } catch (err) {
      pushNotice(`Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    clientRef.current?.setSpeakerMuted(!next);
  };

  const togglePin = async () => {
    if (!window.electronAPI) return;
    setPinned(await window.electronAPI.setPinned(!pinned));
  };

  const newChat = () => {
    clientRef.current?.disconnect();
    setItems([]);
    setThinking(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const statusText = speaking
    ? 'Speaking'
    : micOn
      ? 'Listening'
      : thinking
        ? 'Thinking'
        : status === 'connecting'
          ? 'Connecting'
          : status === 'ready'
            ? 'Online'
            : 'Ready';

  const statusTone = speaking || micOn ? 'live' : thinking || status === 'connecting' ? 'busy' : 'calm';
  const last = items[items.length - 1];
  const showTyping = thinking && !(last?.kind === 'assistant' && last.streaming);
  const isEmpty = items.filter((i) => i.kind !== 'notice').length === 0;

  return (
    <div
      ref={rootRef}
      className={`app platform-${platform} ${micOn ? 'is-listening' : ''} ${speaking ? 'is-speaking' : ''}`}
    >
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob a" />
        <span className="aurora-blob b" />
        <span className="aurora-blob c" />
      </div>

      <header className="titlebar">
        <div className="brand">
          <Orb size="sm" />
          <div className="brand-text">
            <h1>GridSight</h1>
            <span className={`status status-${statusTone}`}>
              <i />
              {statusText}
            </span>
          </div>
        </div>
        <div className="titlebar-actions">
          <button id="btn-new-chat" className="icon-btn" onClick={newChat} title="New conversation">
            <SquarePen size={16} />
          </button>
          <button
            id="btn-speaker"
            className={`icon-btn ${speakerOn ? '' : 'is-off'}`}
            onClick={toggleSpeaker}
            title={speakerOn ? 'Mute voice replies' : 'Unmute voice replies'}
          >
            {speakerOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          {isElectron && (
            <button
              id="btn-pin"
              className={`icon-btn ${pinned ? 'is-active' : ''}`}
              onClick={togglePin}
              title={pinned ? 'Unpin window' : 'Keep on top'}
            >
              {pinned ? <Pin size={16} /> : <PinOff size={16} />}
            </button>
          )}
        </div>
      </header>

      <main ref={scrollRef} className="chat">
        {isEmpty && (
          <section className="welcome">
            <Orb size="lg" />
            <h2>
              Hey there<span className="accent">.</span>
            </h2>
            <p>Chat with me, or ask me to find something on your screen — I’ll move the mouse for you.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s}
                  id={`suggestion-${i}`}
                  className="suggestion"
                  style={{ animationDelay: `${120 + i * 70}ms` }}
                  onClick={() => sendMessage(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="messages">
          {items.map((item) => {
            if (item.kind === 'activity') return <ActivityRow key={item.id} steps={item.steps} done={item.done} />;
            if (item.kind === 'notice')
              return (
                <div key={item.id} className="notice">
                  <AlertCircle size={14} />
                  <span>{item.text}</span>
                </div>
              );
            return (
              <div key={item.id} className={`msg msg-${item.kind}`}>
                <div className="bubble">
                  {item.text}
                  {item.streaming && item.kind === 'assistant' && <span className="caret" />}
                </div>
              </div>
            );
          })}

          {showTyping && (
            <div className="msg msg-assistant">
              <div className="bubble typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="composer-wrap">
        <div className={`composer ${micOn ? 'is-listening' : ''}`}>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={micOn ? 'Listening… or type a message' : 'Message GridSight'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <div className="composer-actions">
            <button
              id="btn-mic"
              className={`mic-btn ${micOn ? 'is-on' : ''}`}
              onClick={toggleMic}
              title={micOn ? 'Stop talking' : 'Talk'}
            >
              <span className="mic-ring" />
              <Mic size={18} />
            </button>
            <button
              id="btn-send"
              className="send-btn"
              onClick={() => sendMessage()}
              disabled={!input.trim()}
              title="Send"
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          </div>
        </div>
        <p className="hint">Enter to send · Shift + Enter for a new line</p>
      </footer>
    </div>
  );
}
