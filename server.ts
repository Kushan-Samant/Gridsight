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
  name: 'capture_screen_with_grid',
  description:
    'Captures the user screen with numbered quadrant sectors (e.g. 1 to 16). The annotated image is streamed to your vision feed. Use this whenever the user wants to point, click, or interact with something on screen.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'Brief description of what target on the screen you are looking for.',
      },
    },
    required: ['reason'],
  },
};

const zoomIntoSectorTool: FunctionDeclaration = {
  name: 'zoom_into_sector',
  description:
    'Zooms in on a numbered quadrant sector (e.g. 1 to 16) where the target icon, button or menu item is located. Crops into that quadrant and splits it into smaller sub-quadrants numbered 1 to 16 for fine millimeter precision. Can be called repeatedly until the sector directly frames the target.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sectorNumber: {
        type: Type.NUMBER,
        description: 'The number (e.g. 1 to 16) of the sector/quadrant containing the target.',
      },
      targetLabel: {
        type: Type.STRING,
        description: 'Name of the UI element or target inside this sector.',
      },
    },
    required: ['sectorNumber', 'targetLabel'],
  },
};

const clickSectorTool: FunctionDeclaration = {
  name: 'click_sector',
  description:
    'Moves the mouse cursor to the center of the specified numbered sector (1 to 16) and clicks it. Use this once you have zoomed in enough that the sector directly covers the target button/icon, or if the target is already clearly centered in that sector.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      sectorNumber: {
        type: Type.NUMBER,
        description: 'The number of the sector to click.',
      },
      button: {
        type: Type.STRING,
        description: 'Which mouse button to click: "left" (default) or "right".',
      },
      doubleClick: {
        type: Type.BOOLEAN,
        description: 'True if opening an app or icon (double click).',
      },
      targetLabel: {
        type: Type.STRING,
        description: 'Name of the target element being clicked.',
      },
    },
    required: ['sectorNumber', 'targetLabel'],
  },
};

const moveMouseToCoordinateTool: FunctionDeclaration = {
  name: 'move_mouse_to_coordinate',
  description:
    'Moves the mouse cursor directly to any exact screen coordinate (x, y) or sector center, with optional clicking.',
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
      click: {
        type: Type.BOOLEAN,
        description: 'Set to true to left-click.',
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

const resetZoomGridTool: FunctionDeclaration = {
  name: 'reset_zoom_grid',
  description: 'Resets the view back to the full screen (Depth 0).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'Reason for resetting the zoom level.',
      },
    },
  },
};

const SYSTEM_INSTRUCTION = `You are GridSight, an AI desktop assistant. You see the user's screen through numbered grids and click what they ask.

HOW YOU CLICK THINGS (YOUR ONLY METHOD):
1. When the user asks you to click, open, or find something on screen:
   Call capture_screen_with_grid.
2. In the screenshot, the screen is sliced into 16 clearly numbered grid boxes (1 to 16, numbered row-by-row: 1-4 top row, 5-8 second row, 9-12 third row, 13-16 bottom row / taskbar).
3. Find which grid box contains the target icon or button:
   - Call zoom_into_sector(sectorNumber: X, targetLabel: "...").
   - This zooms directly into box X and automatically splits it into 16 smaller sub-grid boxes (1 to 16)!
   - If the icon is still small, simply select the new grid box it is inside and zoom again.
4. Once you have zoomed into the box that directly frames the icon:
   - Call click_sector(sectorNumber: Y, doubleClick: true/false, targetLabel: "...").
   - Set doubleClick: true when opening apps, desktop icons, or files.
   - Set doubleClick: false for taskbar buttons, start menu, links, and browser tabs.

CONVERSATION STYLE:
- Do NOT talk about grids, box numbers, or tools to the user.
- Say brief friendly confirmations like "Opening Chrome for you" or "Clicking the Start button".
- Simply find the grid with the icon, zoom in, and click it.`;

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

  // Single-step or recursive Gemini Vision grid analyzer endpoint
  app.post('/api/gemini/inspect-grid', async (req, res) => {
    try {
      const { imageBase64, targetPrompt, region, gridPoints, depth } = req.body;
      if (!targetPrompt) {
        res.status(400).json({ error: 'targetPrompt is required' });
        return;
      }

      const ai = getAiClient();
      const cleanedBase64 = typeof imageBase64 === 'string'
        ? imageBase64.replace(/^data:image\/\w+;base64,/, '')
        : '';

      const promptText = `You are inspecting a screen region at Zoom Depth ${depth ?? 0}.
Current Region Bounds: minX=${region?.minX ?? 0}, minY=${region?.minY ?? 0}, maxX=${region?.maxX ?? 1920}, maxY=${region?.maxY ?? 1080}.
Target requested by user: "${targetPrompt}".
Available Coordinate Grid Points in this image:
${JSON.stringify(gridPoints?.slice(0, 64) ?? [])}

Decide whether one of the grid coordinate points is already directly on the target (within ~12 pixels).
- If YES, set action to "move_mouse_to_coordinate" and provide the exact (x, y) and matchedPointId.
- If NO, set action to "zoom_coordinate_region" and provide the 4 coordinates (topLeft, topRight, bottomLeft, bottomRight) that form a square around the target location so we can provide a zoomed-in image with a finer coordinate grid.`;

      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (cleanedBase64) {
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: cleanedBase64,
          },
        });
      }
      parts.push({ text: promptText });

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              action: {
                type: Type.STRING,
                description: 'Either "zoom_coordinate_region" or "move_mouse_to_coordinate"',
              },
              reasoning: {
                type: Type.STRING,
                description: 'Concise explanation of how the grid points relate to the target.',
              },
              matchedPointId: {
                type: Type.STRING,
                description: 'Grid point ID if action is move_mouse_to_coordinate (e.g. R3C4)',
              },
              moveX: {
                type: Type.NUMBER,
                description: 'Target X coordinate if action is move_mouse_to_coordinate',
              },
              moveY: {
                type: Type.NUMBER,
                description: 'Target Y coordinate if action is move_mouse_to_coordinate',
              },
              topLeftX: { type: Type.NUMBER },
              topLeftY: { type: Type.NUMBER },
              topRightX: { type: Type.NUMBER },
              topRightY: { type: Type.NUMBER },
              bottomLeftX: { type: Type.NUMBER },
              bottomLeftY: { type: Type.NUMBER },
              bottomRightX: { type: Type.NUMBER },
              bottomRightY: { type: Type.NUMBER },
            },
            required: ['action', 'reasoning'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (error: unknown) {
      const errMessage = error instanceof Error ? error.message : 'Failed to inspect coordinate grid with Gemini';
      res.status(500).json({ error: errMessage });
    }
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
              functionDeclarations: [
                captureScreenTool,
                zoomIntoSectorTool,
                clickSectorTool,
                moveMouseToCoordinateTool,
                resetZoomGridTool,
              ],
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
