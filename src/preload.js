const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- Audio (dual-source) ----
  audio: {
    startLoopback: () => ipcRenderer.invoke('start-loopback'),
    startMic: (deviceId) => ipcRenderer.invoke('start-mic', deviceId),
    stopAll: () => ipcRenderer.invoke('stop-audio'),
    getDevices: () => ipcRenderer.invoke('get-audio-devices'),
    // Fire-and-forget PCM chunks (separate channels for interviewer/candidate)
    sendInterviewerChunk: (buf) => ipcRenderer.send('interviewer-audio', buf),
    sendCandidateChunk: (buf) => ipcRenderer.send('candidate-audio', buf),
    // Legacy single-channel (backward compat)
    sendChunkToSTT: (buf) => ipcRenderer.send('audio-chunk-to-stt', buf),
    // Level updates from renderer → main (for forwarding to overlay if needed)
    onLevel: (cb) => ipcRenderer.on('audio-level', (e, d) => cb(d)),
    onSourceChanged: (cb) => ipcRenderer.on('audio-source-changed', (e, d) => cb(d)),
  },

  // ---- Transcription ----
  transcription: {
    start: () => ipcRenderer.invoke('start-transcription'),
    stop: () => ipcRenderer.invoke('stop-transcription'),
    getStatus: () => ipcRenderer.invoke('get-stt-status'),
    onInterim: (cb) => ipcRenderer.on('interim-transcript', (e, d) => cb(d)),
    onFinal: (cb) => ipcRenderer.on('final-transcript', (e, d) => cb(d)),
    onTranslation: (cb) => ipcRenderer.on('translation-ready', (e, d) => cb(d)),
    onServiceSwitch: (cb) => ipcRenderer.on('stt-switched', (e, d) => cb(d)),
    onQuestionDetected: (cb) => ipcRenderer.on('question-detected', (e, d) => cb(d)),
    onStatementDetected: (cb) => ipcRenderer.on('statement-detected', (e, d) => cb(d)),
    onError: (cb) => ipcRenderer.on('stt-error', (e, d) => cb(d)),
  },

  // ---- AI ----
  ai: {
    generateAnswer: (t, c) => ipcRenderer.invoke('generate-answer', t, c),
    translateText: (t) => ipcRenderer.invoke('translate-text', t),
    streamTranslate: (t) => ipcRenderer.invoke('stream-translate', t),
    onTranslationToken: (cb) => ipcRenderer.on('translation-token', (_e, t) => cb(t)),
    regenerateAnswer: (t) => ipcRenderer.invoke('regenerate-answer', t),
    makeShorter: (t) => ipcRenderer.invoke('make-shorter', t),
    makeLonger: (t) => ipcRenderer.invoke('make-longer', t),
    generateFollowup: (t) => ipcRenderer.invoke('generate-followup', t),
    generateRecap: (lines) => ipcRenderer.invoke('generate-recap', lines),
    preGenerateCache: () => ipcRenderer.invoke('pre-generate-cache'),
    onResponse: (cb) => ipcRenderer.on('ai-response', (e, d) => cb(d)),
    onAnswerChunk: (cb) => ipcRenderer.on('answer-chunk', (e, d) => cb(d)),
  },

  // ---- Storage ----
  storage: {
    getConfig: () => ipcRenderer.invoke('storage-get-config'),
    saveConfig: (d) => ipcRenderer.invoke('storage-save-config', d),
  },

  // ---- Files ----
  files: {
    parseFile: (p) => ipcRenderer.invoke('parse-file', p),
    pickAndParse: () => ipcRenderer.invoke('pick-and-parse-file'),
  },

  // ---- Scripts ----
  scripts: {
    save: (t) => ipcRenderer.invoke('save-script', t),
    getAll: () => ipcRenderer.invoke('get-scripts'),
    match: (t) => ipcRenderer.invoke('match-script', t),
  },

  // ---- Session ----
  session: {
    saveTranscript: (d) => ipcRenderer.invoke('session-save-transcript', d),
    generateReport: () => ipcRenderer.invoke('session-generate-report'),
    exportReport: (id) => ipcRenderer.invoke('session-export-report', id),
    exportTranscript: (id) => ipcRenderer.invoke('session-export-transcript', id),
    onReportReady: (cb) => ipcRenderer.on('ai-response', (e, d) => { if (d.type === 'report-ready') cb(d); }),
  },

  // ---- Preflight ----
  preflight: {
    complete: () => ipcRenderer.invoke('preflight-complete'),
    skip: () => ipcRenderer.invoke('preflight-skip'),
  },

  // ---- Stealth ----
  stealth: {
    runSelfTest: () => ipcRenderer.invoke('stealth-self-test'),
    emergencyHide: () => ipcRenderer.invoke('emergency-hide'),
  },

  // ---- Window ----
  window: {
    toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
    openSettings: () => ipcRenderer.invoke('open-settings'),
    closeSettings: () => ipcRenderer.invoke('close-settings'),
    setBounds: (b) => ipcRenderer.invoke('set-overlay-bounds', b),
    setOpacity: (o) => ipcRenderer.invoke('set-overlay-opacity', o),
    moveWindow: (x, y) => ipcRenderer.invoke('move-window', x, y),
    getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  },

  // ---- Debug ----
  debug: {
    log: (...a) => ipcRenderer.send('renderer-log', 'log', a.map(String).join(' ')),
    warn: (...a) => ipcRenderer.send('renderer-log', 'warn', a.map(String).join(' ')),
    error: (...a) => ipcRenderer.send('renderer-log', 'error', a.map(String).join(' ')),
  },

  // ---- Legacy ----
  on: (ch, cb) => {
    const ok = ['transcript-update','ai-response','answer-chunk','stealth-status','audio-level','error'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (e, ...a) => cb(...a));
  }
});
