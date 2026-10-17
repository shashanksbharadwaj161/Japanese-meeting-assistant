// =============================================================================
// Main Process — JapaneseInterviewAssistant (Session 6 Final)
// =============================================================================
// Electron main process: creates windows, manages IPC, coordinates all
// subsystems (audio, transcription, AI, stealth, watchdog).
// =============================================================================

'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { LoopbackCapture } = require('./audio/loopback');
const { ClaudeClient } = require('./ai/claude');
const { FallbackAI } = require('./ai/fallback');
const { AnswerCache } = require('./ai/cache');
const sessionStore = require('./storage/session');
const { applyProtection, reapplyAfterShow } = require('./stealth/protection');
const { runSelfTest } = require('./stealth/selftest');

// Set process title to something innocuous
process.title = 'Windows Audio Service';

// Portable exe: store data beside the .exe
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

let overlayWindow = null;
let settingsWindow = null;
let preflightWindow = null;
let watchdogProcess = null;
let heartbeatInterval = null;

// Audio state tracked in the main process
const audioState = {
  activeSource: null,    // 'loopback' | 'mic' | null
  loopbackReady: false   // whether loopback init succeeded
};

// LoopbackCapture instance (main-process side init)
const loopbackCapture = new LoopbackCapture();

// Claude client + AI (main-process singletons)
let claudeClient = null;
let fallbackAI = null;
let answerCache = null;

// Active session tracking
let activeSessionId = null;

// --------------------------------------------------------------------------
// Window creation
// --------------------------------------------------------------------------

function createOverlayWindow() {
  // Restore saved position/size from config
  const { loadConfig: loadCfgForPanel } = require('./storage/config');
  const savedPanel = (loadCfgForPanel().panel) || {};

  overlayWindow = new BrowserWindow({
    width: savedPanel.width || 500,
    height: savedPanel.height || 400,
    x: savedPanel.x != null ? savedPanel.x : undefined,
    y: savedPanel.y != null ? savedPanel.y : undefined,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: false,
    title: 'Windows Audio Service',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setSkipTaskbar(true);

  overlayWindow.loadFile(path.join(__dirname, 'ui', 'overlay.html'));

  // Re-apply stealth on every show
  overlayWindow.on('show', () => {
    reapplyAfterShow(overlayWindow);
  });

  // Save position/size on move/resize (debounced)
  let savePositionTimer = null;
  function saveOverlayPosition() {
    clearTimeout(savePositionTimer);
    savePositionTimer = setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      const bounds = overlayWindow.getBounds();
      const { loadConfig: lc, saveConfig: sc } = require('./storage/config');
      const cfg = lc();
      cfg.panel = cfg.panel || {};
      cfg.panel.x = bounds.x;
      cfg.panel.y = bounds.y;
      cfg.panel.width = bounds.width;
      cfg.panel.height = bounds.height;
      sc(cfg);
    }, 500);
  }
  overlayWindow.on('moved', saveOverlayPosition);
  overlayWindow.on('resized', saveOverlayPosition);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    skipTaskbar: true,
    title: 'Windows Audio Service',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));

  // Re-apply stealth on every show
  settingsWindow.on('show', () => {
    reapplyAfterShow(settingsWindow);
  });

  settingsWindow.on('close', (e) => {
    e.preventDefault();
    settingsWindow.hide();
  });
}

function createPreflightWindow() {
  preflightWindow = new BrowserWindow({
    width: 600,
    height: 520,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    title: 'Windows Audio Service',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  preflightWindow.setAlwaysOnTop(true, 'screen-saver');
  preflightWindow.setSkipTaskbar(true);

  preflightWindow.loadFile(path.join(__dirname, 'ui', 'preflight.html'));

  // Open DevTools for debugging preflight issues (remove for production)
  preflightWindow.webContents.openDevTools({ mode: 'detach' });

  preflightWindow.on('show', () => {
    reapplyAfterShow(preflightWindow);
  });

  preflightWindow.on('closed', () => {
    preflightWindow = null;
  });
}

// --------------------------------------------------------------------------
// Watchdog
// --------------------------------------------------------------------------

function startWatchdog() {
  try {
    watchdogProcess = fork(path.join(__dirname, 'watchdog.js'), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_EXE_PATH: process.execPath,
        APP_ROOT: path.join(__dirname, '..')
      }
    });

    watchdogProcess.on('message', (msg) => {
      if (msg && msg.type === 'watchdog-ready') {
        console.log('[main] Watchdog ready');
      }
    });

    watchdogProcess.on('exit', (code) => {
      console.log(`[main] Watchdog exited with code ${code}`);
      watchdogProcess = null;
    });

    watchdogProcess.on('error', (err) => {
      console.error('[main] Watchdog error:', err.message);
      watchdogProcess = null;
    });

    // Send heartbeat every 2 seconds
    heartbeatInterval = setInterval(() => {
      if (watchdogProcess && watchdogProcess.connected) {
        watchdogProcess.send({ type: 'heartbeat' });
      }
    }, 2000);
  } catch (err) {
    console.error('[main] Failed to start watchdog:', err.message);
  }
}

function stopWatchdog() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (watchdogProcess) {
    try {
      if (watchdogProcess.connected) {
        watchdogProcess.send({ type: 'shutdown' });
      }
    } catch { /* already disconnected */ }
    watchdogProcess = null;
  }
}

// --------------------------------------------------------------------------
// Keyboard shortcuts
// --------------------------------------------------------------------------

function registerShortcuts() {
  // Ctrl+Shift+H — Emergency hide ALL windows (<100ms)
  // (F1 conflicts with Windows Help / Google Meet shortcuts)
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    console.log('[main] Emergency hide triggered (Ctrl+Shift+H)');
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
    if (preflightWindow && !preflightWindow.isDestroyed()) preflightWindow.hide();
  });

  // Also try to register F1 as backup (may not work if intercepted by OS)
  try {
    globalShortcut.register('F1', () => {
      // Focus the app first, then hide
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.focus();
        setTimeout(() => {
          if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
          if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
          if (preflightWindow && !preflightWindow.isDestroyed()) preflightWindow.hide();
        }, 10);
      }
    });
  } catch {
    console.log('[main] F1 registration failed (OS intercepts it) — using Ctrl+Shift+H only');
  }

  // F2 — Toggle overlay visibility
  globalShortcut.register('F2', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.show();
      }
    }
  });

  // Ctrl+, — Open settings
  globalShortcut.register('CommandOrControl+,', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
    }
  });
}

// --------------------------------------------------------------------------
// Helper: send event to renderer windows
// --------------------------------------------------------------------------

function sendToOverlay(channel, data) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, data);
  }
}

function sendToAll(channel, data) {
  sendToOverlay(channel, data);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, data);
  }
}

// --------------------------------------------------------------------------
// IPC: Forward renderer console logs to main process terminal
// --------------------------------------------------------------------------
ipcMain.on('renderer-log', (event, level, msg) => {
  const prefix = '[renderer]';
  if (level === 'error') console.error(prefix, msg);
  else if (level === 'warn') console.warn(prefix, msg);
  else console.log(prefix, msg);
});

// --------------------------------------------------------------------------
// IPC Handlers — Window management
// --------------------------------------------------------------------------

ipcMain.handle('toggle-overlay', () => {
  if (overlayWindow) {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow.show();
    }
  }
});

ipcMain.handle('emergency-hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
  if (preflightWindow && !preflightWindow.isDestroyed()) preflightWindow.hide();
});

ipcMain.handle('open-settings', () => {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
  }
});

ipcMain.handle('close-settings', () => {
  if (settingsWindow) {
    settingsWindow.hide();
  }
});

ipcMain.handle('get-window-handle', () => {
  if (overlayWindow) {
    return overlayWindow.getNativeWindowHandle();
  }
  return null;
});

ipcMain.handle('set-overlay-bounds', (event, bounds) => {
  if (overlayWindow) {
    const current = overlayWindow.getBounds();
    const newBounds = {
      x: bounds.x != null ? bounds.x : current.x,
      y: bounds.y != null ? bounds.y : current.y,
      width: bounds.width != null ? bounds.width : current.width,
      height: bounds.height != null ? bounds.height : current.height
    };
    overlayWindow.setBounds(newBounds);
  }
});

ipcMain.handle('set-overlay-opacity', (event, opacity) => {
  if (overlayWindow) {
    overlayWindow.setOpacity(Math.max(0.2, Math.min(1, opacity / 100)));
  }
});

ipcMain.handle('get-screen-size', () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const bounds = overlayWindow ? overlayWindow.getBounds() : { x: 0, y: 0, width: 500, height: 400 };
  return { screenWidth: width, screenHeight: height, bounds };
});

ipcMain.handle('move-window', (event, x, y) => {
  if (overlayWindow) {
    overlayWindow.setPosition(Math.round(x), Math.round(y));
  }
});

// --------------------------------------------------------------------------
// IPC Handlers — Preflight → Overlay transition
// --------------------------------------------------------------------------

ipcMain.handle('preflight-complete', () => {
  console.log('[main] IPC: preflight-complete received');
  transitionToOverlay();
});

ipcMain.handle('preflight-skip', () => {
  console.log('[main] IPC: preflight-skip received');
  transitionToOverlay();
});

// If the overlay window exists but isn't visible yet (user still on the
// preflight screen whose "Start Session" button is gated behind self-tests),
// reveal it the moment a real transcript arrives. This guarantees transcripts
// are never produced into a hidden panel.
function ensureOverlayVisible() {
  if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
    console.log('[main] First transcript arrived — auto-revealing overlay');
    transitionToOverlay();
  }
}

function transitionToOverlay() {
  console.log('[main] transitionToOverlay called — overlay.js will now load and start audio capture');

  // Hide and close preflight
  if (preflightWindow && !preflightWindow.isDestroyed()) {
    preflightWindow.hide();
    // Use destroy() instead of close() to bypass any event handlers
    preflightWindow.destroy();
    preflightWindow = null;
    console.log('[main] Preflight window destroyed');
  }

  // Show overlay
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    console.log('[main] Overlay window shown');
    // Stealth re-applied automatically via 'show' event handler
  } else {
    console.error('[main] Overlay window not available!');
  }
}

// --------------------------------------------------------------------------
// IPC Handlers — Stealth
// --------------------------------------------------------------------------

ipcMain.handle('stealth-self-test', async () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return { safe: false, message: 'Overlay window not available' };
  }
  return await runSelfTest(overlayWindow);
});

// --------------------------------------------------------------------------
// IPC Handlers — Audio pipeline
// --------------------------------------------------------------------------

ipcMain.handle('start-loopback', async () => {
  console.log('[main] IPC: start-loopback called. loopbackReady:', audioState.loopbackReady);
  try {
    audioState.activeSource = 'loopback';
    sendToAll('audio-source-changed', {
      source: 'loopback',
      message: 'System audio capture started.'
    });
    return {
      success: true,
      loopbackReady: audioState.loopbackReady,
      message: audioState.loopbackReady
        ? 'Loopback initialized. Call getDisplayMedia in renderer.'
        : 'Loopback init may have failed. Renderer should try anyway and fall back to mic.'
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('start-mic', async (event, deviceId) => {
  try {
    audioState.activeSource = 'mic';
    sendToAll('audio-source-changed', {
      source: 'mic',
      deviceId: deviceId || 'default',
      message: 'Microphone capture started.'
    });
    return { success: true, message: 'Mic capture mode activated.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('stop-audio', async () => {
  audioState.activeSource = null;
  sendToAll('audio-source-changed', {
    source: null,
    message: 'Audio capture stopped.'
  });
  return { success: true };
});

ipcMain.handle('get-audio-devices', async () => {
  return { useRendererEnumeration: true };
});

ipcMain.handle('audio-source-changed', async (event, source, deviceId) => {
  audioState.activeSource = source;
  sendToAll('audio-source-changed', {
    source,
    deviceId: deviceId || null,
    message: source === 'loopback'
      ? 'Switched to system audio capture.'
      : `Switched to microphone${deviceId ? ` (${deviceId})` : ''}.`
  });
  return { success: true, activeSource: source };
});

// --------------------------------------------------------------------------
// IPC Handlers — Dual-Deepgram transcription pipeline
// --------------------------------------------------------------------------
// Two separate Deepgram WebSocket connections:
//   interviewerDG → loopback audio (system audio from Google Meet)
//   candidateDG   → mic audio (the user speaking)
// Only interviewer transcripts trigger answer generation.
// --------------------------------------------------------------------------

const { DeepgramTranscriber } = require('./transcription/deepgram');
const translator = require('./ai/translator');
const questionDetector = require('./ai/questionDetector');

let interviewerDG = null;   // Deepgram WS for system audio
let candidateDG = null;     // Deepgram WS for mic audio
let interviewerChunks = 0;
let candidateChunks = 0;

// Answer-trigger debounce: only fire after speech_final stays stable 300ms.
let pendingQuestionTimer = null;
let lastQuestionSent = '';

ipcMain.handle('start-transcription', async () => {
  const { loadConfig } = require('./storage/config');
  const config = loadConfig();
  const apiKeys = config.apiKeys || {};

  console.log('[main] Starting dual transcription');
  console.log('[main]   Deepgram:', apiKeys.deepgram ? apiKeys.deepgram.substring(0, 8) + '...' : 'MISSING');
  console.log('[main]   Anthropic:', apiKeys.anthropic ? apiKeys.anthropic.substring(0, 12) + '...' : 'MISSING');

  // Stop existing
  if (interviewerDG) { interviewerDG.destroy(); interviewerDG = null; }
  if (candidateDG) { candidateDG.destroy(); candidateDG = null; }
  if (claudeClient) claudeClient.destroy();

  // Claude for answer generation (NOT for translation or question detection)
  claudeClient = new ClaudeClient({ apiKey: apiKeys.anthropic });
  if (config.profile && config.context) claudeClient.setSystemPrompt(config.profile, config.context);

  // Configure translator (uses its own cache + slim Claude fallback)
  translator.configure(apiKeys.anthropic);

  // FallbackAI
  if (fallbackAI) fallbackAI.destroy();
  fallbackAI = new FallbackAI({
    claudeClient, cacheManager: answerCache,
    openaiKey: apiKeys.openai || '',
    profile: config.profile || {}, context: config.context || {}
  });
  fallbackAI.on('fallback-activated', (d) => sendToAll('ai-response', { type: 'fallback-activated', ...d }));
  fallbackAI.on('fallback-recovered', (d) => sendToAll('ai-response', { type: 'fallback-recovered', ...d }));

  // Answer cache
  if (!answerCache) {
    answerCache = new AnswerCache({ claudeClient });
    try { answerCache.init(sessionStore.getDbPath()); fallbackAI.setCacheManager(answerCache); }
    catch (err) { console.error('Cache init failed:', err.message); }
  }

  // Session
  activeSessionId = sessionStore.createSession(
    config.context?.company || '', config.context?.interviewType || '', config.context?.jobTitle || ''
  );

  const lang = config.audio?.language || 'multi';

  // ---- Create ONE diarized Deepgram connection ----
  // A single stream with diarize=true. Deepgram separates speakers:
  //   speaker 0 = interviewer (first to speak), speaker 1 = candidate (you).
  // This avoids both channels showing the same speech when loopback fails.
  if (apiKeys.deepgram) {
    interviewerDG = null;
    candidateDG = new DeepgramTranscriber({
      apiKey: apiKeys.deepgram, tag: 'interviewer', language: lang,
      endpointing: 200, diarize: true, noDelay: true
    });
    const dg = candidateDG;

    dg.on('interim-transcript', (d) => {
      ensureOverlayVisible();
      sendToOverlay('interim-transcript', d);
    });

    dg.on('final-transcript', async (d) => {
      ensureOverlayVisible();
      sendToOverlay('final-transcript', d);

      if (d.speaker === 'candidate') {
        // Your own speech — just record it, never generate an answer.
        console.log('[main] Candidate:', d.text.substring(0, 60));
        if (activeSessionId) {
          try { sessionStore.saveTranscript(activeSessionId, { speaker: 'candidate', jpText: d.text, language: d.language, provider: d.provider }); } catch {}
        }
        return;
      }

      // Interviewer speech — record always (translation streams live in renderer).
      if (activeSessionId) {
        try { sessionStore.saveTranscript(activeSessionId, { speaker: 'interviewer', jpText: d.text, language: d.language, provider: d.provider, confidence: d.confidence }); } catch {}
      }

      // Answer generation ONLY when the utterance is complete (speech_final),
      // and only after the text stays stable for 300ms (debounce). Never on
      // interim or is_final-only events — that caused the early/double trigger.
      if (d.speechFinal === true) {
        console.log('[main] Interviewer (speech_final):', d.text.substring(0, 60));
        clearTimeout(pendingQuestionTimer);
        const stableText = d.text;
        pendingQuestionTimer = setTimeout(() => {
          if (stableText === lastQuestionSent) return;   // dedupe identical utterance
          lastQuestionSent = stableText;
          const qResult = questionDetector.detect(stableText);
          if (qResult.isQuestion) {
            console.log('[main] Question ready (confidence:', qResult.confidence.toFixed(2), 'reason:', qResult.reason, ')');
            sendToOverlay('question-detected', { text: stableText, language: d.language, confidence: qResult.confidence, speaker: 'interviewer' });
          } else {
            sendToOverlay('statement-detected', { text: stableText, speaker: 'interviewer' });
          }
        }, 300);
      }
    });

    dg.on('error', (d) => { sendToAll('stt-error', { ...d }); });
    dg.on('connected', () => {
      console.log('[main] Deepgram connected (single diarized stream)');
      sendToAll('stt-switched', { provider: 'deepgram', reason: 'initial' });
    });

    dg.connect();

    // Wait for connection (4s timeout)
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      dg.once('connected', finish);
      dg.once('error', finish);
      setTimeout(finish, 4000);
    });

    return {
      success: true,
      activeService: dg.isConnected ? 'deepgram' : null,
      sessionId: activeSessionId,
      message: dg.isConnected ? 'Deepgram diarized stream connected' : 'Deepgram connection pending'
    };
  }

  return { success: false, message: 'No Deepgram API key configured' };
});

// ---- Audio chunk routing → single diarized Deepgram connection ----
// Only the mic stream (candidate-audio) feeds the connection. When loopback
// fails the renderer mirrors mic audio onto interviewer-audio too, so feeding
// both would double-send the same PCM. Diarization splits speakers from the
// single mic stream (you + interviewer bleed/loopback).
ipcMain.on('candidate-audio', (event, buf) => {
  candidateChunks++;
  if (candidateDG) candidateDG.sendAudio(buf);
  if (candidateChunks === 1) console.log('[main] First audio chunk, size:', buf?.byteLength || 0);
  if (candidateChunks % 1000 === 0) console.log('[main] Audio chunks:', candidateChunks);
});

// interviewer-audio is a no-op now (would double-feed the diarized stream).
ipcMain.on('interviewer-audio', () => { interviewerChunks++; });

// Legacy single-channel (backward compat with old overlay)
ipcMain.on('audio-chunk-to-stt', (event, buf) => {
  if (candidateDG) candidateDG.sendAudio(buf);
});

ipcMain.handle('stop-transcription', async () => {
  console.log('[main] Stopping transcription');
  if (interviewerDG) { interviewerDG.destroy(); interviewerDG = null; }
  if (candidateDG) { candidateDG.destroy(); candidateDG = null; }
  interviewerChunks = 0;
  candidateChunks = 0;
  clearTimeout(pendingQuestionTimer);
  lastQuestionSent = '';
  if (claudeClient) { claudeClient.cancelAll(); claudeClient.clearHistory(); }
  if (fallbackAI) fallbackAI.stopMonitoring();
  let sessionSummary = null;
  if (activeSessionId) { try { sessionSummary = sessionStore.endSession(activeSessionId); } catch {} }
  console.log('[main] Session stopped');
  return { success: true, sessionSummary };
});

ipcMain.handle('get-stt-status', () => ({
  activeService: candidateDG?.isConnected ? 'deepgram' : null,
  isRunning: !!(candidateDG?.isConnected),
  claudeConfigured: claudeClient?.isConfigured || false,
}));

ipcMain.handle('translate-text', async (event, text) => {
  const r = await translator.translate(text);
  return r.translation ? { success: true, translation: r.translation } : { success: false, message: 'Translation failed' };
});

// Live streaming translation: tokens are pushed to the overlay as they arrive.
let _streamTranslateSeq = 0;
ipcMain.handle('stream-translate', async (event, jpText) => {
  const mySeq = ++_streamTranslateSeq;   // cancel stale streams when newer text arrives
  try {
    await translator.streamTranslate(jpText, (token) => {
      if (mySeq === _streamTranslateSeq) sendToOverlay('translation-token', token);
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
});

// --------------------------------------------------------------------------
// IPC Handlers — AI answer generation
// --------------------------------------------------------------------------

ipcMain.handle('generate-answer', async (event, transcript, config) => {
  const startTime = Date.now();

  // --- Step 1: Check script match first (user's prepared answers) ---
  try {
    const { loadConfig: loadCfg } = require('./storage/config');
    const cfg = loadCfg();
    const scriptPairs = (cfg.scripts && cfg.scripts.pairs) || [];
    if (scriptPairs.length > 0) {
      const scriptMatch = findScriptMatch(transcript, scriptPairs);
      if (scriptMatch.matched) {
        console.log('[main] Script match found (score:', scriptMatch.score.toFixed(2), '):', scriptMatch.question.substring(0, 50));
        sendToOverlay('ai-response', {
          type: 'answer',
          answer: scriptMatch.answer,
          model: 'script',
          fromCache: false,
          source: 'script',
          warning: null
        });
        return { success: true, answer: scriptMatch.answer, model: 'script', source: 'script' };
      }
    }
  } catch { /* non-fatal, fall through to AI */ }

  // --- Step 2: AI generation (fallback cascade) ---
  const chunkHandler = (data) => sendToOverlay('answer-chunk', data);
  if (claudeClient) claudeClient.on('answer-chunk', chunkHandler);

  try {
    let result;
    if (fallbackAI) {
      result = await fallbackAI.generateAnswer(transcript, config || {});
    } else if (claudeClient && claudeClient.isConfigured) {
      result = await claudeClient.generateAnswer(transcript, config || {});
      result = { answer: result.answer, model: result.model, fromCache: false, usage: result.usage };
    } else {
      return { success: false, message: 'No AI provider configured.' };
    }

    // Determine source badge
    const source = result.fromCache ? 'cache' : 'ai';

    sendToOverlay('ai-response', {
      type: 'answer',
      answer: result.answer,
      model: result.model,
      fromCache: result.fromCache || false,
      source,
      warning: result.warning || null
    });

    if (activeSessionId && result.answer) {
      try {
        sessionStore.saveAIResponse(activeSessionId, {
          responseText: result.answer,
          model: result.model,
          fromCache: result.fromCache || false,
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens,
          cachedTokens: result.usage?.cache_read_input_tokens,
          responseTimeMs: Date.now() - startTime
        });
      } catch { /* non-fatal */ }
    }

    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    if (claudeClient) claudeClient.removeListener('answer-chunk', chunkHandler);
  }
});

ipcMain.handle('regenerate-answer', async (event, transcript) => {
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }

  const chunkHandler = (data) => sendToOverlay('answer-chunk', data);
  claudeClient.on('answer-chunk', chunkHandler);

  try {
    const result = await claudeClient.regenerateAnswer(transcript);
    sendToOverlay('ai-response', { type: 'answer', answer: result.answer, model: result.model });

    if (activeSessionId) {
      try {
        sessionStore.saveAIResponse(activeSessionId, {
          responseText: result.answer,
          model: result.model,
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens
        });
      } catch { /* non-fatal */ }
    }

    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    claudeClient.removeListener('answer-chunk', chunkHandler);
  }
});

ipcMain.handle('make-shorter', async (event, transcript) => {
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }

  const chunkHandler = (data) => sendToOverlay('answer-chunk', data);
  claudeClient.on('answer-chunk', chunkHandler);

  try {
    const result = await claudeClient.makeShorter(transcript);
    sendToOverlay('ai-response', { type: 'answer', answer: result.answer, model: result.model });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    claudeClient.removeListener('answer-chunk', chunkHandler);
  }
});

ipcMain.handle('make-longer', async (event, transcript) => {
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }

  const chunkHandler = (data) => sendToOverlay('answer-chunk', data);
  claudeClient.on('answer-chunk', chunkHandler);

  try {
    const result = await claudeClient.makeLonger(transcript);
    sendToOverlay('ai-response', { type: 'answer', answer: result.answer, model: result.model });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    claudeClient.removeListener('answer-chunk', chunkHandler);
  }
});

ipcMain.handle('generate-followup', async (event, transcript) => {
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }
  try {
    const result = await claudeClient.generateFollowup(transcript);
    sendToOverlay('ai-response', { type: 'followup', followups: result.followups });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('generate-recap', async (event, transcriptLines) => {
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }
  try {
    const lines = Array.isArray(transcriptLines) ? transcriptLines : [];
    const result = await claudeClient.generateRecap(lines);
    sendToOverlay('ai-response', { type: 'recap', recap: result.recap });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('pre-generate-cache', async () => {
  const { loadConfig } = require('./storage/config');
  const config = loadConfig();

  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.', generated: 0 };
  }

  if (!answerCache) {
    answerCache = new AnswerCache({ claudeClient });
    try {
      answerCache.init(sessionStore.getDbPath());
    } catch (err) {
      return { success: false, message: `Cache init failed: ${err.message}`, generated: 0 };
    }
  }
  answerCache._claudeClient = claudeClient;

  const progressHandler = (data) => sendToOverlay('ai-response', { type: 'cache-progress', ...data });
  answerCache.on('pre-generate-progress', progressHandler);

  try {
    const result = await answerCache.preGenerate(config.profile, config.context);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message, generated: 0 };
  } finally {
    answerCache.removeListener('pre-generate-progress', progressHandler);
  }
});

// --------------------------------------------------------------------------
// IPC Handlers — Session & Reports
// --------------------------------------------------------------------------

ipcMain.handle('session-generate-report', async () => {
  if (!activeSessionId) {
    return { success: false, message: 'No active session.' };
  }
  if (!claudeClient || !claudeClient.isConfigured) {
    return { success: false, message: 'Claude API key not configured.' };
  }

  try {
    const { report, markdown } = await sessionStore.generateReport(activeSessionId, claudeClient);
    sendToOverlay('ai-response', { type: 'report-ready', report, markdown });
    return { success: true, report, markdown };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('session-export-report', async (event, sessionId) => {
  const sid = sessionId || activeSessionId;
  if (!sid) return { success: false, message: 'No session specified.' };
  try {
    const filePath = sessionStore.exportReport(sid);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('session-export-transcript', async (event, sessionId) => {
  const sid = sessionId || activeSessionId;
  if (!sid) return { success: false, message: 'No session specified.' };
  try {
    const filePath = sessionStore.exportTranscript(sid);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('session-save-transcript', async (event, data) => {
  if (!activeSessionId) return { success: false, message: 'No active session.' };
  try {
    const id = sessionStore.saveTranscript(activeSessionId, data);
    return { success: true, id };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// --------------------------------------------------------------------------
// IPC Handlers — File parsing (Resume/JD upload)
// --------------------------------------------------------------------------

ipcMain.handle('parse-file', async (event, filePath) => {
  try {
    const { parseFile } = require('./utils/fileParser');
    const result = await parseFile(filePath);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('pick-and-parse-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Upload Document',
    filters: [
      { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) {
    return { success: false, canceled: true };
  }

  try {
    const { parseFile } = require('./utils/fileParser');
    const parsed = await parseFile(result.filePaths[0]);
    return { success: true, ...parsed };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

// --------------------------------------------------------------------------
// IPC Handlers — Script matching
// --------------------------------------------------------------------------

ipcMain.handle('save-script', async (event, scriptText) => {
  const { loadConfig, saveConfig } = require('./storage/config');
  const config = loadConfig();
  const pairs = parseScriptText(scriptText);
  config.scripts = config.scripts || {};
  config.scripts.pairs = pairs;
  config.scripts.rawText = scriptText;
  config.scripts.lastUpdated = new Date().toISOString();
  saveConfig(config);
  return { success: true, pairCount: pairs.length, pairs };
});

ipcMain.handle('get-scripts', async () => {
  const { loadConfig } = require('./storage/config');
  const config = loadConfig();
  return config.scripts || { pairs: [], rawText: '' };
});

ipcMain.handle('match-script', async (event, transcript) => {
  const { loadConfig } = require('./storage/config');
  const config = loadConfig();
  const pairs = (config.scripts && config.scripts.pairs) || [];
  if (pairs.length === 0) return { matched: false };
  const match = findScriptMatch(transcript, pairs);
  return match;
});

/**
 * Parse Q&A script text into pairs.
 * Supports: Q:/A: format, numbered format, blank-line-separated pairs.
 */
function parseScriptText(text) {
  if (!text || !text.trim()) return [];

  const pairs = [];
  const lines = text.split('\n').map(l => l.trim());

  // Try Q:/A: format first
  let currentQ = null;
  let currentA = null;

  for (const line of lines) {
    // Q: pattern
    const qMatch = line.match(/^(?:Q[:.]|Question[:.]|\d+[.)]\s*)\s*(.+)/i);
    if (qMatch) {
      // Save previous pair if exists
      if (currentQ && currentA) {
        pairs.push({ question: currentQ.trim(), answer: currentA.trim() });
      }
      currentQ = qMatch[1];
      currentA = null;
      continue;
    }

    // A: pattern
    const aMatch = line.match(/^(?:A[:.]|Answer[:.])\s*(.+)/i);
    if (aMatch) {
      currentA = aMatch[1];
      continue;
    }

    // Continuation of answer (non-empty line after A:)
    if (currentA !== null && line) {
      currentA += ' ' + line;
    }
  }

  // Save last pair
  if (currentQ && currentA) {
    pairs.push({ question: currentQ.trim(), answer: currentA.trim() });
  }

  // If Q:/A: format didn't work, try blank-line-separated pairs
  if (pairs.length === 0) {
    const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
    for (let i = 0; i < blocks.length - 1; i += 2) {
      const q = blocks[i].trim();
      const a = blocks[i + 1]?.trim();
      if (q && a) {
        pairs.push({ question: q, answer: a });
      }
    }
  }

  return pairs;
}

/**
 * Fuzzy match incoming transcript against script pairs.
 * Returns { matched, answer, question, score } or { matched: false }.
 */
function findScriptMatch(transcript, pairs) {
  if (!transcript || !pairs.length) return { matched: false };

  const queryLower = transcript.toLowerCase().trim();
  const queryBigrams = getBigrams(queryLower);

  let bestScore = 0;
  let bestPair = null;

  for (const pair of pairs) {
    const qLower = pair.question.toLowerCase();

    // Bigram similarity
    const bgScore = bigramSimilarity(queryBigrams, getBigrams(qLower));

    // Keyword overlap
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const pairWords = qLower.split(/\s+/).filter(w => w.length > 2);
    const qwSet = new Set(queryWords);
    const pwSet = new Set(pairWords);
    let kwMatches = 0;
    for (const w of qwSet) { if (pwSet.has(w)) kwMatches++; }
    const union = new Set([...qwSet, ...pwSet]);
    const kwScore = union.size > 0 ? kwMatches / union.size : 0;

    const combined = bgScore * 0.5 + kwScore * 0.5;

    if (combined > bestScore) {
      bestScore = combined;
      bestPair = pair;
    }
  }

  if (bestScore >= 0.7 && bestPair) {
    return { matched: true, answer: bestPair.answer, question: bestPair.question, score: bestScore };
  }

  return { matched: false, bestScore };
}

function getBigrams(text) {
  const clean = text.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  const bigrams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    bigrams.add(clean.substring(i, i + 2));
  }
  return bigrams;
}

function bigramSimilarity(bg1, bg2) {
  if (bg1.size === 0 || bg2.size === 0) return 0;
  let matches = 0;
  for (const b of bg1) { if (bg2.has(b)) matches++; }
  const union = new Set([...bg1, ...bg2]);
  return union.size > 0 ? matches / union.size : 0;
}

// --------------------------------------------------------------------------
// Storage IPC
// --------------------------------------------------------------------------

ipcMain.handle('storage-get-config', async () => {
  const { loadConfig } = require('./storage/config');
  return loadConfig();
});

ipcMain.handle('storage-save-config', async (event, data) => {
  const { saveConfig } = require('./storage/config');
  saveConfig(data);
  return { success: true };
});

// --------------------------------------------------------------------------
// App lifecycle
// --------------------------------------------------------------------------

app.whenReady().then(async () => {
  // 1. Load config
  const { loadConfig, getConfigPath } = require('./storage/config');
  console.log('[main] Config path:', getConfigPath());
  const config = loadConfig();

  // 2. Initialize loopback capture (patches getDisplayMedia)
  loopbackCapture.on('initialized', () => {
    audioState.loopbackReady = true;
  });
  loopbackCapture.on('init-failed', (info) => {
    audioState.loopbackReady = false;
    console.error('Loopback init failed:', info.message);
  });
  loopbackCapture.initializeMainProcess();

  // 3. Start watchdog child process
  startWatchdog();

  // 4. Create windows (all hidden initially)
  createOverlayWindow();
  createSettingsWindow();
  createPreflightWindow();

  // 5. Apply stealth protection to overlay (before it's shown)
  try {
    const stealthResult = applyProtection(overlayWindow);
    console.log(`[main] Stealth protection: ${stealthResult.method} (success: ${stealthResult.success})`);
  } catch (err) {
    console.error('[main] Stealth protection error:', err.message);
  }

  // Also protect settings and preflight windows
  try { applyProtection(settingsWindow); } catch { /* non-fatal */ }
  try { applyProtection(preflightWindow); } catch { /* non-fatal */ }

  // 6. Register global keyboard shortcuts
  registerShortcuts();

  // 7. Show preflight window
  preflightWindow.webContents.once('did-finish-load', () => {
    preflightWindow.show();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopWatchdog();
  loopbackCapture.destroy();
  if (interviewerDG) { interviewerDG.destroy(); interviewerDG = null; }
  if (candidateDG) { candidateDG.destroy(); candidateDG = null; }
  if (claudeClient) { claudeClient.destroy(); claudeClient = null; }
  if (fallbackAI) { fallbackAI.destroy(); fallbackAI = null; }
  if (answerCache) { answerCache.destroy(); answerCache = null; }
  sessionStore.closeDatabase();
});

app.on('window-all-closed', () => {
  stopWatchdog();
  loopbackCapture.destroy();
  if (interviewerDG) { interviewerDG.destroy(); interviewerDG = null; }
  if (candidateDG) { candidateDG.destroy(); candidateDG = null; }
  if (claudeClient) { claudeClient.destroy(); claudeClient = null; }
  if (fallbackAI) { fallbackAI.destroy(); fallbackAI = null; }
  if (answerCache) { answerCache.destroy(); answerCache = null; }
  sessionStore.closeDatabase();
  app.quit();
});
