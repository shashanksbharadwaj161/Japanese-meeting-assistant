// ==========================================================================
// Overlay Renderer — Production-grade dual audio, premium UI, full features
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  // ---------- DOM references ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    header:              $('header'),
    statusDot:           $('status-dot'),
    statusText:          $('status-text'),
    loopbackBar:         $('loopback-bar'),
    micBar:              $('mic-bar'),
    opacitySlider:       $('opacity-slider'),
    btnFontUp:           $('btn-font-up'),
    btnFontDown:         $('btn-font-down'),
    btnMini:             $('btn-mini'),
    btnHide:             $('btn-hide'),
    headerSpacer:        $('header-spacer'),
    interviewerSection:  $('interviewer-section'),
    jpTranscript:        $('jp-transcript'),
    enTranslation:       $('en-translation'),
    answerSection:       $('answer-section'),
    answerBadge:         $('answer-badge'),
    answerNav:           $('answer-nav'),
    btnHistPrev:         $('btn-hist-prev'),
    btnHistNext:         $('btn-hist-next'),
    histPos:             $('hist-pos'),
    answerContent:       $('answer-content'),
    answerModel:         $('answer-model'),
    youSection:          $('you-section'),
    candidateTranscript: $('candidate-transcript'),
    controlBar:          $('control-bar'),
    btnShorter:          $('btn-shorter'),
    btnLonger:           $('btn-longer'),
    btnFollowup:         $('btn-followup'),
    btnRegen:            $('btn-regenerate'),
    snapIndicator:       $('snap-indicator'),
    contextMenu:         $('context-menu'),
    miniRomaji:          $('mini-romaji'),
  };

  // ---------- Constants ----------
  const FONTS = ['xs', 's', 'm', 'l', 'xl'];
  const FONT_LABELS = { xs: 'XS', s: 'S', m: 'M', l: 'L', xl: 'XL' };
  const MIN_WIDTH = 320;
  const MIN_HEIGHT = 180;
  const SNAP_THRESHOLD = 20;
  const METER_FPS = 20;
  const SAVE_DEBOUNCE_MS = 600;
  const TRANSLATION_FADE_MS = 8000;

  // ---------- State ----------
  const state = {
    opacity: 75,
    fontIdx: 3,               // index into FONTS, default 'l'
    mini: false,
    showENSubs: true,
    paused: false,
    streaming: false,
    streamBuf: '',

    // Answer history
    history: [],              // Array of { text, source, model, enQuestion }
    histIdx: -1,              // -1 = latest live answer

    // Transcript state
    lastTranscript: '',
    recentLines: [],

    // Audio
    loopbackOk: false,
    micOk: false,
    loopbackLevel: 0,
    micLevel: 0,

    // Window geometry (loaded from config)
    bounds: null,
    screenSize: null,

    // Current answer text (for toolbar actions)
    currentAnswerText: '',
  };

  // ---------- Logging ----------
  function log(...args) {
    const msg = args.map(String).join(' ');
    console.log(msg);
    try { window.api.debug.log(msg); } catch (_) { /* noop */ }
  }

  function warn(...args) {
    const msg = args.map(String).join(' ');
    console.warn(msg);
    try { window.api.debug.warn(msg); } catch (_) { /* noop */ }
  }

  // ---------- Utility ----------
  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ==========================================================================
  // 1. LOAD CONFIG & APPLY INITIAL STATE
  // ==========================================================================

  let config = {};
  try {
    config = await window.api.storage.getConfig() || {};
  } catch (e) {
    warn('[overlay] Failed to load config:', e.message);
  }

  // Restore display preferences
  if (config.display) {
    state.opacity = config.display.opacity || 75;
    state.showENSubs = config.display.showENSubs !== false;
    const fontMap = { small: 1, medium: 2, large: 3 };
    state.fontIdx = fontMap[config.display.fontSize] || 3;
  }
  if (config.panel) {
    state.opacity = config.panel.opacity || state.opacity;
    state.bounds = config.panel.bounds || null;
  }

  applyOpacity(state.opacity);
  applyFont(state.fontIdx);
  if (!state.showENSubs) document.body.classList.add('hide-en-subs');

  // ==========================================================================
  // 2. DISPLAY HELPERS
  // ==========================================================================

  function setStatus(type, text) {
    el.statusDot.className = 'status-dot ' + type;
    el.statusText.textContent = text;
  }

  function applyOpacity(v) {
    v = clamp(v, 20, 100);
    state.opacity = v;
    document.body.style.opacity = (v / 100).toString();
    el.opacitySlider.value = v;
    try { window.api.window.setOpacity(v); } catch (_) { /* noop */ }
  }

  function applyFont(idx) {
    idx = clamp(idx, 0, FONTS.length - 1);
    state.fontIdx = idx;
    FONTS.forEach(f => document.body.classList.remove('font-' + f));
    document.body.classList.add('font-' + FONTS[idx]);
  }

  // ==========================================================================
  // 3. AUDIO LEVEL METERS (20fps visual update)
  // ==========================================================================

  let meterRAF = null;

  function updateMeterBar(bar, level) {
    const pct = clamp(level * 4.5, 0, 1);
    bar.style.width = (pct * 100) + '%';
    if (pct > 0.75) {
      bar.style.background = '#EF4444';
    } else if (pct > 0.35) {
      bar.style.background = '#EAB308';
    } else {
      bar.style.background = '#22C55E';
    }
  }

  function meterLoop() {
    updateMeterBar(el.loopbackBar, state.loopbackLevel);
    updateMeterBar(el.micBar, state.micLevel);
    // Decay levels slightly so bars drop when silent
    state.loopbackLevel *= 0.85;
    state.micLevel *= 0.85;
    meterRAF = requestAnimationFrame(meterLoop);
  }

  // Start meter rendering at ~display refresh rate (capped by requestAnimationFrame)
  meterRAF = requestAnimationFrame(meterLoop);

  // ==========================================================================
  // 4. ANSWER FORMATTING & HISTORY
  // ==========================================================================

  // Build the formatted romaji + → English DOM. Used by BOTH the live stream
  // and the final render so there is no raw→formatted swap (no flicker).
  // EN: / question lines are always skipped so the question is never shown.
  function renderAnswerLines(text, animate) {
    el.answerContent.innerHTML = '';
    if (!text) return;

    const isArrow = (s) => s.startsWith('→') || s.startsWith('->');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let i = 0, idx = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Never render the question / EN: header lines.
      if (line.startsWith('EN:')) { i += 1; continue; }

      if (isArrow(line)) {
        const prev = el.answerContent.lastElementChild;
        if (prev && !prev.querySelector('.en-sub')) {
          const sub = document.createElement('div');
          sub.className = 'en-sub';
          sub.textContent = line.replace(/^(→|->)\s*/, '');
          prev.appendChild(sub);
        }
        i += 1;
        continue;
      }

      const div = document.createElement('div');
      div.className = 'answer-line';
      if (animate) div.style.animationDelay = (idx * 60) + 'ms';
      else div.style.animation = 'none';   // no re-fade while streaming

      const rom = document.createElement('div');
      rom.className = 'romaji';
      rom.textContent = line;
      div.appendChild(rom);

      const next = lines[i + 1] ? lines[i + 1].trim() : '';
      if (next && isArrow(next)) {
        const sub = document.createElement('div');
        sub.className = 'en-sub';
        sub.textContent = next.replace(/^(→|->)\s*/, '');
        div.appendChild(sub);
        i += 2;
      } else {
        i += 1;
      }

      el.answerContent.appendChild(div);
      idx++;
    }

    // Fallback: never blank if the badge/nav already showed.
    if (el.answerContent.children.length === 0 && text.trim()) {
      const div = document.createElement('div');
      div.className = 'answer-line';
      const rom = document.createElement('div');
      rom.className = 'romaji';
      rom.textContent = text.trim();
      div.appendChild(rom);
      el.answerContent.appendChild(div);
    }
  }

  function formatAnswer(text, pushToHistory, source, model) {
    if (!text) { el.answerContent.innerHTML = ''; return; }

    state.currentAnswerText = text;
    renderAnswerLines(text, true);

    if (pushToHistory !== false) {
      state.history.push({ text, source: source || 'ai', model: model || '', enQuestion: '' });
      if (state.history.length > 30) state.history.shift();
      state.histIdx = state.history.length - 1;
      updateHistoryNav();
    }

    const firstRomaji = el.answerContent.querySelector('.romaji');
    if (firstRomaji && el.miniRomaji) {
      const txt = firstRomaji.textContent;
      el.miniRomaji.textContent = txt.length > 50 ? txt.substring(0, 50) + '...' : txt;
    }

    el.answerSection.scrollTop = 0;
  }

  function updateHistoryNav() {
    const len = state.history.length;
    if (len <= 1) {
      el.answerNav.classList.add('hidden');
      return;
    }
    el.answerNav.classList.remove('hidden');
    const pos = state.histIdx + 1;
    el.histPos.textContent = pos + '/' + len;
    el.btnHistPrev.disabled = (state.histIdx <= 0);
    el.btnHistNext.disabled = (state.histIdx >= len - 1);
  }

  function navigateHistory(delta) {
    const len = state.history.length;
    if (len === 0) return;

    let newIdx = state.histIdx + delta;
    newIdx = clamp(newIdx, 0, len - 1);
    if (newIdx === state.histIdx) return;

    state.histIdx = newIdx;
    const entry = state.history[newIdx];
    formatAnswer(entry.text, false);
    updateSourceBadge(entry.source);
    if (entry.model) el.answerModel.textContent = entry.model;
    updateHistoryNav();
  }

  function updateSourceBadge(source) {
    const emoji = { script: '📝', cache: '💾', ai: '🤖' };
    const label = { script: 'Script', cache: 'Cache', ai: 'AI' };
    const src = source || 'ai';
    el.answerBadge.textContent = (emoji[src] || '🤖') + ' ' + (label[src] || 'AI');
    el.answerBadge.className = 'source-badge ' + src;
  }

  // ==========================================================================
  // 5. TRANSCRIPTION EVENT HANDLERS
  // ==========================================================================

  // Live-streaming translation state for the interviewer section.
  let lastTranslatedText = '';

  // Fire a streaming translation immediately (no debounce). Tokens come back
  // via onTranslationToken and append to the EN line in real time.
  function kickTranslation(jpText) {
    lastTranslatedText = jpText;
    state.currentTranslation = '';
    el.enTranslation.textContent = '';
    window.api.ai.streamTranslate(jpText);   // fire-and-forget
  }

  window.api.transcription.onInterim((d) => {
    if (d.speaker === 'candidate') {
      el.candidateTranscript.textContent = d.text;
      el.candidateTranscript.className = 'transcript-line candidate-text interim';
      setStatus('live', 'live');
      return;
    }

    // Interviewer: show JP as small reference below, stream EN live above.
    el.jpTranscript.textContent = d.text;

    // Start on the VERY FIRST interim (>=2 chars); restart whenever the
    // transcript grew by more than 3 chars. No timers, no delay.
    if (d.text) {
      const grew = d.text.length - lastTranslatedText.length;
      const firstFire = lastTranslatedText === '' && d.text.length >= 2;
      if (firstFire || grew > 3) kickTranslation(d.text);
    }
    setStatus('live', 'live');
  });

  window.api.transcription.onFinal((d) => {
    if (d.speaker === 'candidate') {
      el.candidateTranscript.textContent = d.text;
      el.candidateTranscript.className = 'transcript-line candidate-text final';
      setStatus('live', 'live');
      return;
    }

    // Interviewer final: lock JP reference, do a final clean translation pass.
    el.jpTranscript.textContent = d.text;
    state.lastTranscript = d.text;
    state.recentLines.push(d.text);
    if (state.recentLines.length > 50) {
      state.recentLines = state.recentLines.slice(-50);
    }
    if (d.text && d.text !== lastTranslatedText) {
      kickTranslation(d.text);
    }
    setStatus('live', 'live');
  });

  // Streaming translation tokens arrive here — append live to the EN line.
  window.api.ai.onTranslationToken((token) => {
    state.currentTranslation = (state.currentTranslation || '') + token;
    el.enTranslation.textContent = state.currentTranslation;
  });

  window.api.transcription.onQuestionDetected((d) => {
    setStatus('thinking', 'thinking...');
    window.api.ai.generateAnswer(d.text, {});
  });

  window.api.transcription.onStatementDetected(() => {
    // No special handling for statements
  });

  window.api.transcription.onServiceSwitch((d) => {
    if (d.provider) {
      const label = d.tag ? d.tag + ':' + d.provider : d.provider;
      setStatus('live', label);
    }
  });

  window.api.transcription.onError((d) => {
    if (d.allFailed) {
      setStatus('error', 'STT failed');
      el.jpTranscript.textContent = 'No STT available — check Settings (Ctrl+,)';
    } else {
      setStatus('error', 'error');
    }
  });

  // ==========================================================================
  // 6. AI ANSWER STREAMING & RESPONSE HANDLERS
  // ==========================================================================

  window.api.ai.onAnswerChunk((d) => {
    // Streaming finished — drop the cursor, keep the formatted lines as-is.
    if (d.done) {
      state.streaming = false;
      state.lastStreamBuf = state.streamBuf;
      renderAnswerLines(state.streamBuf, false);   // remove cursor, no rebuild flash
      setStatus('live', 'live');
      return;
    }

    // First chunk of a NEW answer — clear the box exactly once.
    if (!state.streaming) {
      state.streaming = true;
      state.streamBuf = '';
      el.answerContent.innerHTML = '';
      setStatus('thinking', 'generating...');
    }

    // Append delta and re-render formatted (romaji + → English, EN: stripped).
    state.streamBuf += d.text;
    renderAnswerLines(state.streamBuf, false);

    // Blinking cursor on the last romaji line.
    const last = el.answerContent.lastElementChild;
    const lastRom = last && last.querySelector('.romaji');
    if (lastRom) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      lastRom.appendChild(cursor);
    }

    el.answerSection.scrollTop = el.answerSection.scrollHeight;
  });

  window.api.ai.onResponse((d) => {
    if (d.type === 'answer' && d.answer) {
      const src = d.source || (d.fromCache ? 'cache' : 'ai');
      // If streaming already rendered this exact answer, finalize WITHOUT
      // rebuilding the DOM (prevents the end-of-stream flicker/reload).
      if (state.lastStreamBuf && d.answer.trim() === state.lastStreamBuf.trim()) {
        state.currentAnswerText = d.answer;
        state.history.push({ text: d.answer, source: src, model: d.model || '', enQuestion: '' });
        if (state.history.length > 30) state.history.shift();
        state.histIdx = state.history.length - 1;
        updateHistoryNav();
      } else {
        formatAnswer(d.answer, true, src, d.model);
      }
      state.lastStreamBuf = '';
      updateSourceBadge(src);
      if (d.model) el.answerModel.textContent = d.model;
      setStatus('live', 'live');
    }

    if (d.type === 'followup' && d.followups) {
      el.answerContent.innerHTML =
        '<div class="answer-stream-raw">' + escapeHtml(d.followups) + '</div>';
      updateSourceBadge('ai');
      setStatus('live', 'live');
    }

    if (d.type === 'recap' && d.recap) {
      el.answerContent.innerHTML =
        '<div class="answer-stream-raw">' + escapeHtml(d.recap) + '</div>';
      updateSourceBadge('ai');
      setStatus('live', 'live');
    }
  });

  // ==========================================================================
  // 7. HEADER CONTROLS
  // ==========================================================================

  // Opacity slider
  el.opacitySlider.addEventListener('input', () => {
    applyOpacity(parseInt(el.opacitySlider.value, 10));
    saveDebounced();
  });

  // Font size buttons
  el.btnFontUp.addEventListener('click', () => {
    if (state.fontIdx < FONTS.length - 1) {
      applyFont(state.fontIdx + 1);
      saveDebounced();
    }
  });

  el.btnFontDown.addEventListener('click', () => {
    if (state.fontIdx > 0) {
      applyFont(state.fontIdx - 1);
      saveDebounced();
    }
  });

  // Mini mode toggle
  function toggleMini() {
    state.mini = !state.mini;
    document.body.classList.toggle('mini-mode', state.mini);
    if (state.mini) {
      window.api.window.setBounds({ height: 44 });
    } else {
      const h = (state.bounds && state.bounds.height) || (config.panel && config.panel.height) || 420;
      window.api.window.setBounds({ height: h });
    }
    saveDebounced();
  }

  el.btnMini.addEventListener('click', toggleMini);

  // Double-click header to toggle mini
  el.header.addEventListener('dblclick', (e) => {
    const target = e.target;
    if (target === el.header || target === el.headerSpacer ||
        target === el.statusDot || target === el.statusText ||
        target.closest('#meter-wrap')) {
      toggleMini();
    }
  });

  // Emergency hide
  el.btnHide.addEventListener('click', () => {
    window.api.stealth.emergencyHide();
  });

  // Answer history navigation buttons
  el.btnHistPrev.addEventListener('click', () => navigateHistory(-1));
  el.btnHistNext.addEventListener('click', () => navigateHistory(1));

  // ==========================================================================
  // 8. CONTROL BAR BUTTONS
  // ==========================================================================

  function busyBtn(btn, busy) {
    btn.disabled = busy;
  }

  el.btnShorter.addEventListener('click', async () => {
    if (!state.currentAnswerText) return;
    busyBtn(el.btnShorter, true);
    setStatus('thinking', 'shorter...');
    try { await window.api.ai.makeShorter(state.currentAnswerText); } catch (_) { /* noop */ }
    busyBtn(el.btnShorter, false);
  });

  el.btnLonger.addEventListener('click', async () => {
    if (!state.currentAnswerText) return;
    busyBtn(el.btnLonger, true);
    setStatus('thinking', 'longer...');
    try { await window.api.ai.makeLonger(state.currentAnswerText); } catch (_) { /* noop */ }
    busyBtn(el.btnLonger, false);
  });

  el.btnFollowup.addEventListener('click', async () => {
    busyBtn(el.btnFollowup, true);
    setStatus('thinking', 'follow-up...');
    try { await window.api.ai.generateFollowup(state.lastTranscript); } catch (_) { /* noop */ }
    busyBtn(el.btnFollowup, false);
  });

  el.btnRegen.addEventListener('click', async () => {
    if (!state.lastTranscript) return;
    busyBtn(el.btnRegen, true);
    setStatus('thinking', 'regen...');
    try { await window.api.ai.regenerateAnswer(state.lastTranscript); } catch (_) { /* noop */ }
    busyBtn(el.btnRegen, false);
  });

  // ==========================================================================
  // 9. KEYBOARD SHORTCUTS
  // ==========================================================================

  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;

    // F1 = Emergency hide
    if (key === 'F1') {
      e.preventDefault();
      window.api.stealth.emergencyHide();
      return;
    }

    // F2 = Pause/toggle overlay
    if (key === 'F2') {
      e.preventDefault();
      window.api.window.toggleOverlay();
      return;
    }

    // F3 = Follow-up
    if (key === 'F3') {
      e.preventDefault();
      el.btnFollowup.click();
      return;
    }

    // F4 = Recap
    if (key === 'F4') {
      e.preventDefault();
      triggerRecap();
      return;
    }

    // Ctrl shortcuts
    if (ctrl) {
      // Ctrl+M = mini mode
      if (key === 'm' || key === 'M') {
        e.preventDefault();
        toggleMini();
        return;
      }
      // Ctrl+, = settings
      if (key === ',' || key === '<') {
        e.preventDefault();
        window.api.window.openSettings();
        return;
      }
      // Ctrl+= / Ctrl++ = font up
      if (key === '=' || key === '+') {
        e.preventDefault();
        el.btnFontUp.click();
        return;
      }
      // Ctrl+- = font down
      if (key === '-') {
        e.preventDefault();
        el.btnFontDown.click();
        return;
      }
      // Ctrl+Shift+H = emergency hide (must check before Ctrl+H)
      if (e.shiftKey && (key === 'h' || key === 'H')) {
        e.preventDefault();
        window.api.stealth.emergencyHide();
        return;
      }
      // Ctrl+H = toggle overlay
      if (key === 'h' || key === 'H') {
        e.preventDefault();
        window.api.window.toggleOverlay();
        return;
      }
    }

    // Arrow keys (no modifier)
    if (!ctrl && !e.shiftKey && !e.altKey) {
      // Up = shorter
      if (key === 'ArrowUp') {
        e.preventDefault();
        el.btnShorter.click();
        return;
      }
      // Down = longer
      if (key === 'ArrowDown') {
        e.preventDefault();
        el.btnLonger.click();
        return;
      }
      // Left = history prev
      if (key === 'ArrowLeft') {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
      // Right = history next
      if (key === 'ArrowRight') {
        e.preventDefault();
        navigateHistory(1);
        return;
      }
      // Tab = toggle EN subs
      if (key === 'Tab') {
        e.preventDefault();
        state.showENSubs = !state.showENSubs;
        document.body.classList.toggle('hide-en-subs', !state.showENSubs);
        saveDebounced();
        return;
      }
      // Space = force answer for current transcript
      if (key === ' ' && !state.streaming && state.lastTranscript) {
        e.preventDefault();
        setStatus('thinking', 'generating...');
        window.api.ai.generateAnswer(state.lastTranscript, {});
        return;
      }
    }
  });

  // Recap helper
  async function triggerRecap() {
    busyBtn(el.btnFollowup, true);
    setStatus('thinking', 'recap...');
    try {
      await window.api.ai.generateRecap(state.recentLines.slice(-20));
    } catch (_) { /* noop */ }
    busyBtn(el.btnFollowup, false);
  }

  // ==========================================================================
  // 10. DRAG HEADER TO MOVE WINDOW
  // ==========================================================================

  (function initDrag() {
    let dragging = false;
    let startScreenX = 0;
    let startScreenY = 0;
    let startWinX = 0;
    let startWinY = 0;

    el.header.addEventListener('mousedown', async (e) => {
      // Only drag on header background, spacer, status elements, meter wrap
      const t = e.target;
      if (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.closest('.nav-btn')) return;

      e.preventDefault();
      dragging = true;
      startScreenX = e.screenX;
      startScreenY = e.screenY;

      try {
        const info = await window.api.window.getScreenSize();
        if (info && info.bounds) {
          startWinX = info.bounds.x;
          startWinY = info.bounds.y;
          state.bounds = info.bounds;
          state.screenSize = info.screenSize || info;
        }
      } catch (_) { /* noop */ }
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.screenX - startScreenX;
      const dy = e.screenY - startScreenY;
      let newX = startWinX + dx;
      let newY = startWinY + dy;

      // Snap to edges
      const snapped = checkSnap(newX, newY, state.bounds ? state.bounds.width : 400, state.bounds ? state.bounds.height : 300);
      if (snapped.x !== null) newX = snapped.x;
      if (snapped.y !== null) newY = snapped.y;
      showSnapIndicator(snapped);

      window.api.window.moveWindow(newX, newY);
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      hideSnapIndicator();
      saveDebounced();
    });
  })();

  // ==========================================================================
  // 11. RESIZE HANDLES (8 directions)
  // ==========================================================================

  (function initResize() {
    document.querySelectorAll('.resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const dir = handle.dataset.dir;
        const startX = e.screenX;
        const startY = e.screenY;
        let bounds = null;
        let screenW = 1920;
        let screenH = 1080;

        try {
          const info = await window.api.window.getScreenSize();
          if (info) {
            bounds = info.bounds ? { ...info.bounds } : null;
            if (info.screenSize) {
              screenW = info.screenSize.width || 1920;
              screenH = info.screenSize.height || 1080;
            }
          }
        } catch (_) { /* noop */ }

        if (!bounds) return;

        const maxW = Math.floor(screenW * 0.9);
        const maxH = Math.floor(screenH * 0.9);
        const origBounds = { ...bounds };

        const onMove = (ev) => {
          const dx = ev.screenX - startX;
          const dy = ev.screenY - startY;
          const nb = { ...origBounds };

          if (dir.includes('e')) nb.width = origBounds.width + dx;
          if (dir.includes('w')) { nb.x = origBounds.x + dx; nb.width = origBounds.width - dx; }
          if (dir.includes('s')) nb.height = origBounds.height + dy;
          if (dir.includes('n')) { nb.y = origBounds.y + dy; nb.height = origBounds.height - dy; }

          // Enforce min/max
          nb.width = clamp(nb.width, MIN_WIDTH, maxW);
          nb.height = clamp(nb.height, MIN_HEIGHT, maxH);

          // If clamped, fix position for w/n directions
          if (dir.includes('w') && nb.width === MIN_WIDTH) {
            nb.x = origBounds.x + origBounds.width - MIN_WIDTH;
          }
          if (dir.includes('n') && nb.height === MIN_HEIGHT) {
            nb.y = origBounds.y + origBounds.height - MIN_HEIGHT;
          }

          window.api.window.setBounds(nb);
          state.bounds = nb;
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          saveDebounced();
        };

        document.body.style.cursor = handle.style.cursor;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  })();

  // ==========================================================================
  // 12. SNAP TO SCREEN EDGES
  // ==========================================================================

  function checkSnap(x, y, w, h) {
    const result = { x: null, y: null, edge: null };
    if (!state.screenSize) return result;

    const sw = state.screenSize.width || 1920;
    const sh = state.screenSize.height || 1080;

    // Left edge
    if (Math.abs(x) < SNAP_THRESHOLD) {
      result.x = 0;
      result.edge = 'left';
    }
    // Right edge
    if (Math.abs((x + w) - sw) < SNAP_THRESHOLD) {
      result.x = sw - w;
      result.edge = 'right';
    }
    // Top edge
    if (Math.abs(y) < SNAP_THRESHOLD) {
      result.y = 0;
      result.edge = result.edge ? result.edge : 'top';
    }
    // Bottom edge
    if (Math.abs((y + h) - sh) < SNAP_THRESHOLD) {
      result.y = sh - h;
      result.edge = result.edge ? result.edge : 'bottom';
    }

    return result;
  }

  function showSnapIndicator(snap) {
    if (!snap.edge) {
      hideSnapIndicator();
      return;
    }
    el.snapIndicator.className = 'snap-indicator snap-' + snap.edge;
  }

  function hideSnapIndicator() {
    el.snapIndicator.className = 'snap-indicator hidden';
  }

  // ==========================================================================
  // 13. RIGHT-CLICK CONTEXT MENU
  // ==========================================================================

  (function initContextMenu() {
    // Open context menu on right-click anywhere on panel
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = el.contextMenu;
      menu.classList.remove('hidden');

      // Position near click, but keep within viewport
      let mx = e.clientX;
      let my = e.clientY;
      const mw = 190;
      const mh = 200;
      if (mx + mw > window.innerWidth) mx = window.innerWidth - mw - 4;
      if (my + mh > window.innerHeight) my = window.innerHeight - mh - 4;
      menu.style.left = mx + 'px';
      menu.style.top = my + 'px';
    });

    // Close menu on click outside
    document.addEventListener('click', () => {
      el.contextMenu.classList.add('hidden');
    });

    // Handle context menu items
    el.contextMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.ctx-item');
      if (!item) return;

      const opacity = item.dataset.opacity;
      const action = item.dataset.action;

      if (opacity) {
        applyOpacity(parseInt(opacity, 10));
        saveDebounced();
      }
      if (action === 'settings') {
        window.api.window.openSettings();
      }
      if (action === 'recap') {
        triggerRecap();
      }

      el.contextMenu.classList.add('hidden');
    });
  })();

  // ==========================================================================
  // 14. SAVE CONFIG (debounced)
  // ==========================================================================

  let saveTimer = null;

  function saveDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const c = await window.api.storage.getConfig() || {};

        c.display = c.display || {};
        c.display.opacity = state.opacity;
        c.display.showENSubs = state.showENSubs;
        const fontNames = { 0: 'xsmall', 1: 'small', 2: 'medium', 3: 'large', 4: 'xlarge' };
        c.display.fontSize = fontNames[state.fontIdx] || 'large';

        c.panel = c.panel || {};
        c.panel.opacity = state.opacity;
        if (state.bounds) {
          c.panel.bounds = state.bounds;
          c.panel.width = state.bounds.width;
          c.panel.height = state.bounds.height;
        }
        c.panel.mini = state.mini;
        c.panel.fontIdx = state.fontIdx;

        await window.api.storage.saveConfig(c);
      } catch (e) {
        warn('[overlay] Save config error:', e.message);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // ==========================================================================
  // 15. EMERGENCY HIDE (F1) — <50ms response
  // ==========================================================================

  // F1 is handled in keyboard shortcuts above, calling window.api.stealth.emergencyHide()
  // The body.panel-hidden class provides the CSS fade, but for true <50ms hide
  // we rely on the main process to hide the BrowserWindow immediately.

  // ==========================================================================
  // 16. STARTUP SEQUENCE — Dual audio capture + transcription
  // ==========================================================================

  log('[overlay] === STARTUP ===');
  setStatus('thinking', 'starting...');

  // Step 1: Start transcription (connects Deepgram WS in main process)
  const txPromise = window.api.transcription.start().catch(e => ({
    success: false,
    message: e.message || 'Transcription start failed',
  }));
  log('[overlay] Transcription connecting...');

  // Step 2: Capture loopback audio (system/interviewer)
  let loopbackStream = null;
  let loopbackCtx = null;

  try {
    loopbackStream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      },
      video: false,
    });

    const loopbackTrack = loopbackStream.getAudioTracks()[0];
    const loopbackRate = (loopbackTrack && loopbackTrack.getSettings().sampleRate) || 48000;
    loopbackCtx = new AudioContext({ sampleRate: loopbackRate });

    await loopbackCtx.audioWorklet.addModule('./pcm-worklet.js');

    const loopbackSrc = loopbackCtx.createMediaStreamSource(loopbackStream);
    const loopbackWorklet = new AudioWorkletNode(loopbackCtx, 'pcm-chunker', {
      processorOptions: { targetRate: 16000 },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });

    loopbackWorklet.port.onmessage = (e) => {
      if (e.data.type === 'audio') {
        window.api.audio.sendInterviewerChunk(e.data.buffer);
        state.loopbackLevel = e.data.level;
      }
    };

    loopbackSrc.connect(loopbackWorklet);
    loopbackWorklet.connect(loopbackCtx.destination);
    state.loopbackOk = true;
    log('[overlay] Loopback capture OK (rate=' + loopbackRate + ')');
  } catch (err) {
    warn('[overlay] Loopback failed:', err.message, '-- interviewer audio via mic fallback');
  }

  // Step 3: Capture microphone (candidate + fallback for interviewer)
  let micStream = null;
  let micCtx = null;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    const micTrack = micStream.getAudioTracks()[0];
    const micRate = (micTrack && micTrack.getSettings().sampleRate) || 48000;
    micCtx = new AudioContext({ sampleRate: micRate });

    await micCtx.audioWorklet.addModule('./pcm-worklet.js');

    const micSrc = micCtx.createMediaStreamSource(micStream);
    const micWorklet = new AudioWorkletNode(micCtx, 'pcm-chunker', {
      processorOptions: { targetRate: 16000 },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });

    micWorklet.port.onmessage = (e) => {
      if (e.data.type === 'audio') {
        window.api.audio.sendCandidateChunk(e.data.buffer);
        state.micLevel = e.data.level;
        // Fallback: if no loopback, send mic to interviewer channel too
        if (!state.loopbackOk) {
          window.api.audio.sendInterviewerChunk(e.data.buffer);
        }
      }
    };

    micSrc.connect(micWorklet);
    micWorklet.connect(micCtx.destination);
    state.micOk = true;
    log('[overlay] Mic capture OK (rate=' + micRate + ')');
  } catch (err) {
    warn('[overlay] Mic failed:', err.message);
  }

  // Step 4: Wait for transcription
  const txResult = await txPromise;
  log('[overlay] Transcription result:', JSON.stringify(txResult));

  // Final status
  if (txResult && txResult.success) {
    if (state.loopbackOk && state.micOk) {
      setStatus('live', 'dual audio');
    } else if (state.micOk) {
      setStatus('live', 'mic only');
    } else if (state.loopbackOk) {
      setStatus('live', 'loopback only');
    } else {
      setStatus('error', 'no audio');
    }
  } else {
    setStatus('error', (txResult && txResult.message) || 'STT failed');
  }

  if (!state.loopbackOk && !state.micOk) {
    setStatus('error', 'no audio');
    el.jpTranscript.textContent = 'No audio source — check permissions';
  }

  log('[overlay] === READY === loopback:', state.loopbackOk, 'mic:', state.micOk);
});
