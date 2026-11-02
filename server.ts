import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  FunctionDeclaration,
  LiveServerMessage,
  Modality,
  Type,
} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const captureScreenTool: FunctionDeclaration = {
  name: 'capture_screen',
  description: 'Captures the user screen. Use this to take a look at what the user is doing if needed.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'Reason for capturing the screen.',
      },
    },
    required: ['reason'],
  },
};

const getWindowsUiTreeTool: FunctionDeclaration = {
  name: 'get_windows_ui_tree',
  description: 'Gets the semantic UI tree of the current active Windows application. It returns a string representing the layout and controls on the screen, along with their exact (X, Y) center coordinates. Always use this to understand the layout before clicking.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'Why you need to extract the UI tree.',
      }
    },
    required: ['reason']
  },
};

const clickUiElementTool: FunctionDeclaration = {
  name: 'click_ui_element',
  description: 'Moves the mouse cursor to the given (x, y) coordinates and clicks.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      x: {
        type: Type.NUMBER,
        description: 'Screen X coordinate in pixels.',
      },
      y: {
        type: Type.NUMBER,
        description: 'Screen Y coordinate in pixels.',
      },
      button: {
        type: Type.STRING,
        description: 'Which mouse button to click: "left" (default) or "right".',
      },
      doubleClick: {
        type: Type.BOOLEAN,
        description: 'Set to true to double-click.',
      },
      targetLabel: {
        type: Type.STRING,
        description: 'Name of the target UI element.',
      },
    },
    required: ['x', 'y', 'targetLabel'],
  },
};

const SYSTEM_INSTRUCTION = `You are GridSight, an AI desktop assistant. You control the user's screen by extracting their application's UI tree, and then clicking exactly on the coordinates provided in that tree.

HOW YOU SEE THE SCREEN:
If you need to visually see what the user is doing or looking at, call the capture_screen tool.

HOW YOU CLICK THINGS (YOUR ONLY METHOD):
1. When the user asks you to click, open, or find something on screen:
   - Call get_windows_ui_tree.
2. In the returned UI tree, you will see elements, their names, their types, and their exact center=(x, y) coordinates.
3. Find the coordinates for the requested target element.
4. Call click_ui_element(x, y, targetLabel: "..."). Set doubleClick: true when opening apps, desktop icons, or files.

CONVERSATION STYLE:
- Do NOT talk about UI trees, automation elements, or tools to the user.
- Say brief friendly confirmations like "Opening Chrome for you" or "Clicking the Start button".
- Simply find the element in the UI tree and click it.`;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const server = http.createServer(app);

  // Health & runtime capabilities endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      liveModel: 'gemini-3.8-live',
      visionModel: 'gemini-3.8-flash',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
    });
  });

  // WebSocket Server for Gemini Live (Real-Time Voice + Annotated Screen Grid + Tool Calling)
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws/live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs: WebSocket) => {
    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const ai = getAiClient();
      liveSession = await ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Screenshots count as video; without compression sessions end after ~2 minutes
          contextWindowCompression: { slidingWindow: {} },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Zephyr',
              },
            },
          },
          tools: [
            {
              functionDeclarations: [captureScreenTool, getWindowsUiTreeTool, clickUiElementTool],
            },
          ],
          systemInstruction: SYSTEM_INSTRUCTION,
        },
        callbacks: {
          onopen: () => {
            sendToClient({ type: 'session_open', model: 'gemini-3.8-live' });
          },
          onmessage: (message: LiveServerMessage) => {
            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              sendToClient({
                type: 'input_transcript',
                text: content.inputTranscription.text,
              });
            }
            if (content?.outputTranscription?.text) {
              sendToClient({
                type: 'output_transcript',
                text: content.outputTranscription.text,
              });
            }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                sendToClient({
                  type: 'audio',
                  audio: part.inlineData.data,
                });
              }
              if (part.text) {
                sendToClient({
                  type: 'model_text',
                  text: part.text,
                });
              }
            }
            if (content?.interrupted) {
              sendToClient({ type: 'interrupted' });
            }
            if (content?.turnComplete) {
              sendToClient({ type: 'turn_complete' });
            }
            if (message.toolCall?.functionCalls?.length) {
              for (const call of message.toolCall.functionCalls) {
                sendToClient({
                  type: 'tool_call',
                  id: call.id,
                  name: call.name,
                  args: call.args ?? {},
                });
              }
            }
          },
          onerror: (err: unknown) => {
            const msg = err instanceof Error ? err.message : 'Gemini Live session error';
            sendToClient({ type: 'error', error: msg });
          },
          onclose: () => {
            sendToClient({ type: 'session_closed' });
            if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
          },
        },
      });
      // Only now is liveSession assigned, so the client can safely start sending
      sendToClient({ type: 'session_ready' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to initialize Gemini Live session';
      sendToClient({ type: 'error', error: msg });
      clientWs.close();
    }

    clientWs.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        if (!liveSession) return;

        if (msg.type === 'audio' && msg.data) {
          liveSession.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (msg.type === 'audio_end') {
          liveSession.sendRealtimeInput({ audioStreamEnd: true });
        } else if (msg.type === 'video' && msg.data) {
          const cleaned = String(msg.data).replace(/^data:image\/\w+;base64,/, '');
          liveSession.sendRealtimeInput({
            video: {
              data: cleaned,
              mimeType: 'image/jpeg',
            },
          });
        } else if (msg.type === 'text' && msg.text) {
          liveSession.sendRealtimeInput({
            text: String(msg.text),
          });
        } else if (msg.type === 'tool_response' && msg.id && msg.name) {
          // If the tool response includes a newly zoomed annotated grid image, stream that frame first
          if (msg.annotatedImageBase64) {
            const cleaned = String(msg.annotatedImageBase64).replace(/^data:image\/\w+;base64,/, '');
            liveSession.sendRealtimeInput({
              video: {
                data: cleaned,
                mimeType: 'image/jpeg',
              },
            });
          }
          liveSession.sendToolResponse({
            functionResponses: [
              {
                id: msg.id,
                name: msg.name,
                response: msg.response ?? { status: 'ok' },
              },
            ],
          });
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Failed processing client WebSocket message';
        sendToClient({ type: 'error', error: errMsg });
      }
    });

    clientWs.on('close', () => {
      try {
        liveSession?.close();
      } catch {
        // Ignore close errors
      }
    });
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GridSight Live server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
