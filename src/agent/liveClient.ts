/**
 * LiveClient — talks to the local Gemini Live bridge (/ws/live).
 * Handles the WebSocket session, microphone streaming, speech playback,
 * and routes tool calls to the hidden ScreenAgent.
 */
import { AgentActivity, ScreenAgent } from './screenAgent';

export type ConnectionStatus = 'idle' | 'connecting' | 'ready';

export type LiveEvent =
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'user_transcript'; text: string }
  | { type: 'assistant_transcript'; text: string }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'mic'; on: boolean }
  | { type: 'error'; message: string };

function float32ToPcm16Base64(input: Float32Array): string {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

function rms(analyser: AnalyserNode | null, buf: Float32Array<ArrayBuffer> | null): number {
  if (!analyser || !buf) return 0;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

interface MicState {
  stream: MediaStream;
  ctx: AudioContext;
  processor: ScriptProcessorNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private agent: ScreenAgent;
  private toolQueue: Promise<void> = Promise.resolve();

  private outCtx: AudioContext | null = null;
  private outGain: GainNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private outBuf: Float32Array<ArrayBuffer> | null = null;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();

  private mic: MicState | null = null;
  private speakerMuted = false;

  constructor(private readonly emit: (event: LiveEvent) => void) {
    this.agent = new ScreenAgent((activity) => this.emit({ type: 'activity', activity }));
  }

  /* --------------------------- session --------------------------- */

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.emit({ type: 'status', status: 'connecting' });

    const attempt = new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/live`);
      this.ws = ws;
      let settled = false;

      ws.onmessage = (ev) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'session_ready' && !settled) {
          settled = true;
          this.emit({ type: 'status', status: 'ready' });
          resolve();
        } else if (msg.type === 'error' && !settled) {
          settled = true;
          reject(new Error(msg.error || 'Could not start a Gemini Live session'));
        }
        this.handleMessage(msg);
      };

      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.ready = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error('Could not reach the GridSight backend'));
        }
        this.stopPlayback();
        this.stopMic(false);
        this.emit({ type: 'status', status: 'idle' });
      };
    });

    this.ready = attempt;
    attempt.catch(() => {
      if (this.ready === attempt) this.ready = null;
    });
    return attempt;
  }

  disconnect() {
    this.stopMic(false);
    this.stopPlayback();
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  async sendText(text: string) {
    this.ensureOutputAudio();
    await this.connect();
    this.send({ type: 'text', text });
  }

  /* --------------------------- messages -------------------------- */

  private handleMessage(msg: Record<string, any>) {
    switch (msg.type) {
      case 'audio':
        if (msg.audio) this.playChunk(msg.audio);
        break;
      case 'input_transcript':
        if (msg.text) this.emit({ type: 'user_transcript', text: msg.text });
        break;
      case 'output_transcript':
        if (msg.text) this.emit({ type: 'assistant_transcript', text: msg.text });
        break;
      case 'model_text':
        if (msg.text) this.emit({ type: 'assistant_transcript', text: msg.text });
        break;
      case 'turn_complete':
        this.emit({ type: 'turn_complete' });
        break;
      case 'interrupted':
        this.stopPlayback();
        this.emit({ type: 'interrupted' });
        break;
      case 'tool_call':
        this.enqueueToolCall(msg.id, msg.name, msg.args ?? {});
        break;
      case 'error':
        if (msg.error) this.emit({ type: 'error', message: msg.error });
        break;
    }
  }

  private enqueueToolCall(id: string, name: string, args: Record<string, unknown>) {
    // Run sequentially — zoom steps depend on the previous region
    this.toolQueue = this.toolQueue.then(async () => {
      console.log(`[LiveClient] TOOL_CALL received: ${name}`, args);
      const result = await this.agent.handleToolCall(name, args);
      console.log(`[LiveClient] TOOL_RESULT:`, result.response);
      this.send({
        type: 'tool_response',
        id,
        name,
        annotatedImageBase64: result.imageBase64,
        response: result.response,
      });
    });
  }

  /* ---------------------------- output --------------------------- */

  private ensureOutputAudio() {
    if (this.outCtx && this.outCtx.state !== 'closed') {
      if (this.outCtx.state === 'suspended') void this.outCtx.resume();
      return;
    }
    const ctx = new AudioContext({ sampleRate: 24000 });
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    gain.gain.value = this.speakerMuted ? 0 : 1;

    this.outCtx = ctx;
    this.outGain = gain;
    this.outAnalyser = analyser;
    this.outBuf = new Float32Array(analyser.fftSize);
    this.nextStart = 0;
  }

  private playChunk(base64: string) {
    this.ensureOutputAudio();
    const ctx = this.outCtx!;
    const samples = pcm16Base64ToFloat32(base64);
    if (!samples.length) return;

    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.outGain!);

    const startAt = Math.max(ctx.currentTime + 0.02, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  private stopPlayback() {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  setSpeakerMuted(muted: boolean) {
    this.speakerMuted = muted;
    if (this.outGain) this.outGain.gain.value = muted ? 0 : 1;
  }

  /* ----------------------------- mic ----------------------------- */

  get micOn() {
    return Boolean(this.mic);
  }

  async startMic() {
    if (this.mic) return;
    this.ensureOutputAudio();
    await this.connect();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;

    source.connect(analyser);
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    processor.onaudioprocess = (e) => {
      this.send({ type: 'audio', data: float32ToPcm16Base64(e.inputBuffer.getChannelData(0)) });
    };

    this.mic = { stream, ctx, processor, analyser, buf: new Float32Array(analyser.fftSize) };
    this.emit({ type: 'mic', on: true });
  }

  stopMic(notifyServer = true) {
    if (!this.mic) return;
    const { stream, ctx, processor } = this.mic;
    processor.onaudioprocess = null;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    this.mic = null;
    if (notifyServer) this.send({ type: 'audio_end' });
    this.emit({ type: 'mic', on: false });
  }

  /* --------------------------- metering -------------------------- */

  getMicLevel(): number {
    return rms(this.mic?.analyser ?? null, this.mic?.buf ?? null);
  }

  getOutputLevel(): number {
    return rms(this.outAnalyser, this.outBuf);
  }

  get isSpeaking(): boolean {
    return Boolean(this.outCtx && this.sources.size > 0 && this.outCtx.currentTime < this.nextStart);
  }
}
