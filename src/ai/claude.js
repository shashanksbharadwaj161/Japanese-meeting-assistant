// ============================================================================
// Claude API Client — Answer Generation + Translation + Classification
// ============================================================================
//
// Models (exact strings):
//   Primary:  claude-haiku-4-5       (fast, cheap, $1/$5 per Mtok)
//   Fallback: claude-sonnet-4-6      (better analysis, $3/$15 per Mtok)
//
// Answer format output:
//   EN: [English translation of question]
//
//   [romaji line 1]
//   → [English subtitle line 1]
//
//   [romaji line 2]
//   → [English subtitle line 2]
//
// Prompt caching: system prompt marked with cache_control: {type: "ephemeral"}
//   → 90% discount on input tokens after first request in session
//
// Streaming: uses /v1/messages with stream=true for token-by-token output
// AbortController: cancels in-flight request when new question arrives
// Translation cache: LRU 100 entries, in-memory only
// ============================================================================

const { EventEmitter } = require('events');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_HAIKU = 'claude-haiku-4-5';
const MODEL_SONNET = 'claude-sonnet-4-6';
const TRANSLATION_CACHE_MAX = 100;

// Length presets → sentence counts for the system prompt
const LENGTH_MAP = {
  short: { sentences: '2-3', maxTokens: 300 },
  medium: { sentences: '4-5', maxTokens: 500 },
  detailed: { sentences: '6-8', maxTokens: 700 }
};

class ClaudeClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.apiKey - Anthropic API key (from config, never hardcoded)
   * @param {string} options.model  - Override default model
   */
  constructor(options = {}) {
    super();

    this.apiKey = options.apiKey || '';
    this.model = options.model || MODEL_HAIKU;

    // Coaching state
    this._systemPrompt = null;
    this._conversationHistory = [];
    this._maxHistoryTurns = 30;
    this._lastTranscript = '';

    // Translation LRU cache
    this._translationCache = new Map();

    // Active answer generation controller (cancel when new question arrives)
    this._answerController = null;

    // All in-flight controllers
    this._inflightControllers = new Set();

    // Stats
    this._stats = {
      totalRequests: 0,
      translationRequests: 0,
      classifyRequests: 0,
      coachingRequests: 0,
      cacheHits: 0,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      totalOutputTokens: 0,
      errors: 0
    };
  }

  get isConfigured() { return !!this.apiKey; }
  get stats() { return { ...this._stats }; }

  // -----------------------------------------------------------------------
  // System prompt (rebuilt from config at session start — nothing hardcoded)
  // -----------------------------------------------------------------------

  setSystemPrompt(profile, context) {
    const lengthInfo = LENGTH_MAP[profile.length || 'medium'] || LENGTH_MAP.medium;

    this._systemPrompt = [
      {
        type: 'text',
        text: this._buildSystemPrompt(profile, context, lengthInfo),
        cache_control: { type: 'ephemeral' }
      }
    ];
  }

  _buildSystemPrompt(profile, context, lengthInfo) {
    return [
      'You are a real-time interview coaching assistant for Japanese/English bilingual interviews.',
      'You generate answers the candidate can READ ALOUD in real-time during a live interview.',
      '',
      '=== CANDIDATE PROFILE ===',
      `JLPT Level: ${profile.level || 'N3'}`,
      `Speaking style: ${profile.style || 'polite'}`,
      `Output format: ${profile.format || 'romaji'}`,
      `Tone: ${profile.tone || 'humble'}`,
      `Answer length: ${lengthInfo.sentences} sentences`,
      '',
      '=== INTERVIEW CONTEXT ===',
      context.company ? `Company: ${context.company}` : '',
      context.interviewType ? `Interview type: ${context.interviewType}` : '',
      context.jobDescription ? `Job description:\n${context.jobDescription}` : '',
      context.resume ? `Candidate background:\n${context.resume}` : '',
      context.emphasize ? `Points to emphasize: ${context.emphasize}` : '',
      context.avoid ? `Topics to avoid: ${context.avoid}` : '',
      '',
      '=== OUTPUT FORMAT (STRICT) ===',
      'You MUST format every answer EXACTLY like this — romaji line, then its English meaning:',
      '',
      '[romaji line 1]',
      '→ [English meaning of line 1]',
      '',
      '[romaji line 2]',
      '→ [English meaning of line 2]',
      '',
      '[romaji line 3]',
      '→ [English meaning of line 3]',
      '',
      'NEVER repeat or restate the question. NEVER output an "EN:" line or any header. Start directly with the first romaji line.',
      '',
      '=== ANSWER STYLE RULES ===',
      '1. SPOKEN WORD: Write how a real person talks, not a textbook or essay.',
      '2. VOCABULARY: Use only N3/N4 level words. No rare kanji readings. Common everyday vocabulary.',
      '3. SHORT SENTENCES: Each romaji line must be short enough to read in one breath while speaking.',
      '4. CULTURALLY APPROPRIATE: Use humble framing (kenjougo), indirect expressions.',
      '   Start answers with appropriate fillers like "Hai", "Sou desu ne" before the main content.',
      '5. NATURAL FIRST-PERSON: Use "watashi wa" naturally, not stiff corporate Japanese.',
      '6. LENGTH: Exactly ' + lengthInfo.sentences + ' romaji lines per answer.',
      '7. ROMAJI RULES: Use standard Hepburn romanization. Separate particles with spaces.',
      '   Example: "Watashi wa mae no kaisha de sannnenkan hataraite imashita."',
      '8. Each → subtitle should be a natural English equivalent, not a word-for-word translation.',
      '',
      '=== IMPORTANT ===',
      'The candidate reads your romaji output LIVE during the interview.',
      'Every second counts. Be concise. No explanations, no alternatives, no meta-commentary.',
      'Just output the formatted answer immediately.'
    ].filter(Boolean).join('\n');
  }

  // -----------------------------------------------------------------------
  // Answer generation with streaming
  // -----------------------------------------------------------------------

  /**
   * Generate a coached answer. Streams tokens via 'answer-chunk' events.
   * Cancels any previous in-flight answer generation.
   *
   * @param {string} transcript     - The interview question
   * @param {object} config         - { length, variation } overrides
   * @returns {Promise<{answer, usage, cacheHit, model}>}
   */
  async generateAnswer(transcript, config = {}) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    // Cancel any previous answer generation
    if (this._answerController) {
      this._answerController.abort();
      this._answerController = null;
    }

    this._stats.coachingRequests++;
    this._lastTranscript = transcript;

    const length = config.length || 'medium';
    const lengthInfo = LENGTH_MAP[length] || LENGTH_MAP.medium;
    const variation = config.variation || '';

    let userContent = `Interview question:\n${transcript}`;
    if (variation) {
      userContent += `\n\nVariation instruction: ${variation}`;
    }
    userContent += '\n\nProvide a coached answer in the exact format specified.';

    this._conversationHistory.push({ role: 'user', content: userContent });

    if (this._conversationHistory.length > this._maxHistoryTurns * 2) {
      this._conversationHistory = this._conversationHistory.slice(-this._maxHistoryTurns * 2);
    }

    const controller = new AbortController();
    this._answerController = controller;
    this._inflightControllers.add(controller);

    // Timeout: if no response in 4 seconds, reject (triggers fallback)
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
      const body = {
        model: config.model || this.model,
        max_tokens: lengthInfo.maxTokens,
        temperature: 0.7,
        stream: true,
        system: this._systemPrompt,
        messages: this._conversationHistory
      };

      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        this._stats.errors++;
        throw new Error(`Claude API ${response.status}: ${errText}`);
      }

      // Stream SSE response
      const fullAnswer = await this._streamResponse(response, controller);

      this._conversationHistory.push({ role: 'assistant', content: fullAnswer.text });

      return {
        answer: fullAnswer.text,
        usage: fullAnswer.usage,
        cacheHit: (fullAnswer.usage?.cache_read_input_tokens || 0) > 0,
        model: config.model || this.model
      };

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError' || err.message === 'Request cancelled') {
        throw new Error('Request cancelled or timed out');
      }
      this._stats.errors++;
      throw err;
    } finally {
      this._inflightControllers.delete(controller);
      if (this._answerController === controller) {
        this._answerController = null;
      }
    }
  }

  /**
   * Stream SSE response, emitting 'answer-chunk' for each text delta.
   */
  async _streamResponse(response, controller) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let usage = {};
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;

          let event;
          try { event = JSON.parse(jsonStr); } catch { continue; }

          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            this.emit('answer-chunk', {
              text: event.delta.text,
              fullText,
              done: false
            });
          }

          if (event.type === 'message_delta' && event.usage) {
            usage = { ...usage, ...event.usage };
          }

          if (event.type === 'message_start' && event.message?.usage) {
            usage = { ...usage, ...event.message.usage };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Track stats
    this._stats.totalRequests++;
    if (usage) {
      this._stats.totalInputTokens += usage.input_tokens || 0;
      this._stats.cachedInputTokens += usage.cache_read_input_tokens || 0;
      this._stats.totalOutputTokens += usage.output_tokens || 0;
    }

    this.emit('answer-chunk', { text: '', fullText, done: true });
    return { text: fullText, usage };
  }

  // -----------------------------------------------------------------------
  // Convenience wrappers for UI actions
  // -----------------------------------------------------------------------

  async regenerateAnswer(transcript) {
    return this.generateAnswer(transcript || this._lastTranscript, {
      variation: 'Give a different variation of the answer. Use different phrasing and examples.'
    });
  }

  async makeShorter(transcript) {
    return this.generateAnswer(transcript || this._lastTranscript, { length: 'short' });
  }

  async makeLonger(transcript) {
    return this.generateAnswer(transcript || this._lastTranscript, { length: 'detailed' });
  }

  async generateFollowup(transcript) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const data = await this._callAPI({
      model: this.model,
      max_tokens: 400,
      system: this._systemPrompt,
      messages: [{
        role: 'user',
        content: `The interview just covered this topic:\n"${transcript || this._lastTranscript}"\n\n`
               + 'Suggest 3 follow-up questions the interviewer might ask next.\n'
               + 'Format each as:\n'
               + 'Q1: [Japanese question in romaji]\n'
               + '→ [English translation]\n\n'
               + 'Q2: ...\n\nQ3: ...'
      }]
    });

    return { followups: data.content[0].text, usage: data.usage };
  }

  async generateRecap(transcriptLines) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const data = await this._callAPI({
      model: this.model,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Summarize the key points from the last few minutes of this interview transcript:\n\n`
               + transcriptLines.join('\n')
               + `\n\nProvide a brief summary in English (3-5 bullet points).`
      }]
    });

    return { recap: data.content[0].text, usage: data.usage };
  }

  // -----------------------------------------------------------------------
  // Translation (cached, fast, called on every transcript)
  // -----------------------------------------------------------------------

  /**
   * Pre-seed the translation cache with common interview phrases.
   * Called at session start for instant translation of common phrases.
   */
  preSeedTranslationCache() {
    const seeds = {
      'こんにちは': 'Hello',
      'よろしくお願いします': 'Thank you in advance / Nice to meet you',
      'お疲れ様です': 'Thank you for your hard work',
      '自己紹介をお願いします': 'Please introduce yourself',
      '自己紹介': 'Self-introduction',
      '強みは何ですか': 'What are your strengths?',
      '弱みは何ですか': 'What are your weaknesses?',
      'なぜこの会社を選びましたか': 'Why did you choose this company?',
      'キャリア目標': 'Career goals',
      '何か質問はありますか': 'Do you have any questions?',
      'ありがとうございました': 'Thank you very much',
      'はい': 'Yes',
      'そうですね': 'That\'s right / Let me think...',
      '失礼します': 'Excuse me',
      'お願いします': 'Please',
      '分かりました': 'I understand',
      '前職について教えてください': 'Please tell us about your previous job',
      'チームワークの経験': 'Teamwork experience',
      'ストレス管理': 'Stress management',
      '五年後の自分': 'Where do you see yourself in 5 years',
      '志望動機': 'Motivation for applying'
    };
    for (const [jp, en] of Object.entries(seeds)) {
      this._translationCache.set(jp, en);
    }
    console.log('[claude] Pre-seeded', Object.keys(seeds).length, 'translation cache entries');
  }

  async translateToEnglish(japaneseText) {
    if (!japaneseText || !japaneseText.trim()) return '';
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const cacheKey = japaneseText.trim();

    if (this._translationCache.has(cacheKey)) {
      const cached = this._translationCache.get(cacheKey);
      // LRU: move to end
      this._translationCache.delete(cacheKey);
      this._translationCache.set(cacheKey, cached);
      this._stats.cacheHits++;
      return cached;
    }

    this._stats.translationRequests++;

    // Slim prompt — no system prompt, minimal tokens for speed
    const data = await this._callAPI({
      model: this.model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Translate to English: ${japaneseText}`
      }]
    });

    const translation = data.content[0].text.trim();

    this._translationCache.set(cacheKey, translation);
    if (this._translationCache.size > TRANSLATION_CACHE_MAX) {
      const oldestKey = this._translationCache.keys().next().value;
      this._translationCache.delete(oldestKey);
    }

    return translation;
  }

  async translateText(japaneseText) {
    return this.translateToEnglish(japaneseText);
  }

  // -----------------------------------------------------------------------
  // Question classification
  // -----------------------------------------------------------------------

  async classifyQuestion(text) {
    if (!text || !text.trim()) return 'NO';
    if (!this.apiKey) return 'NO';

    this._stats.classifyRequests++;

    try {
      const data = await this._callAPI({
        model: this.model,
        max_tokens: 4,
        messages: [{
          role: 'user',
          content: `Is this an interview question needing an answer? YES or NO only.\n"${text}"`
        }]
      });

      return data.content[0].text.trim().toUpperCase();
    } catch {
      return 'NO';
    }
  }

  // -----------------------------------------------------------------------
  // Report generation (uses Sonnet 4.6 for better analysis)
  // -----------------------------------------------------------------------

  async generateReport(fullTranscript, sessionMeta) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const transcriptText = fullTranscript.map(t =>
      `[${t.timestamp}] ${t.speaker}: ${t.jpText || t.text}${t.enText ? ` / ${t.enText}` : ''}`
    ).join('\n');

    const data = await this._callAPI({
      model: MODEL_SONNET,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Analyze this Japanese interview transcript and generate a detailed report.\n\n`
               + `Company: ${sessionMeta.company || 'Unknown'}\n`
               + `Role: ${sessionMeta.interviewType || 'Unknown'}\n`
               + `Date: ${sessionMeta.date || new Date().toISOString().split('T')[0]}\n\n`
               + `TRANSCRIPT:\n${transcriptText}\n\n`
               + `Return a JSON object with exactly these fields:\n`
               + `{\n`
               + `  "summary": "Brief overall summary",\n`
               + `  "questionsAsked": [{"jp": "...", "en": "...", "yourAnswer": "...", "betterAnswer": "..."}],\n`
               + `  "fluencyScore": 1-10,\n`
               + `  "vocabularyAssessment": "...",\n`
               + `  "thingsWentWell": ["point1", "point2", "point3"],\n`
               + `  "areasToImprove": ["point1", "point2", "point3"],\n`
               + `  "culturalScore": 1-10,\n`
               + `  "recommendedStudyTopics": ["topic1", "topic2"]\n`
               + `}\n\nReturn ONLY valid JSON, no markdown fences.`
      }]
    });

    const reportText = data.content[0].text.trim();
    try {
      return JSON.parse(reportText);
    } catch {
      return { summary: reportText, parseError: true };
    }
  }

  // -----------------------------------------------------------------------
  // Pre-generation for cache (called during preflight)
  // -----------------------------------------------------------------------

  async preGenerateAnswer(questionPrompt, profile, context) {
    if (!this.apiKey) throw new Error('Anthropic API key not configured');

    const systemPrompt = [{
      type: 'text',
      text: this._buildSystemPrompt(
        profile || { level: 'N3', style: 'polite', format: 'romaji', tone: 'humble', length: 'medium' },
        context || {},
        LENGTH_MAP.medium
      ),
      cache_control: { type: 'ephemeral' }
    }];

    const data = await this._callAPI({
      model: this.model,
      max_tokens: 500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Interview question:\n${questionPrompt}\n\nProvide a coached answer in the exact format specified.`
      }]
    });

    return data.content[0].text;
  }

  // -----------------------------------------------------------------------
  // Core API call (non-streaming) with abort + stats
  // -----------------------------------------------------------------------

  async _callAPI(body) {
    this._stats.totalRequests++;

    const controller = new AbortController();
    this._inflightControllers.add(controller);

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text();
        this._stats.errors++;
        throw new Error(`Claude API ${response.status}: ${errText}`);
      }

      const data = await response.json();

      if (data.usage) {
        this._stats.totalInputTokens += data.usage.input_tokens || 0;
        this._stats.cachedInputTokens += data.usage.cache_read_input_tokens || 0;
        this._stats.totalOutputTokens += data.usage.output_tokens || 0;
      }

      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Request cancelled');
      this._stats.errors++;
      throw err;
    } finally {
      this._inflightControllers.delete(controller);
    }
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  cancelAll() {
    for (const c of this._inflightControllers) c.abort();
    this._inflightControllers.clear();
    this._answerController = null;
  }

  clearHistory() { this._conversationHistory = []; }
  clearTranslationCache() { this._translationCache.clear(); }

  getEstimatedCost() {
    const uncached = this._stats.totalInputTokens - this._stats.cachedInputTokens;
    const inputCost = uncached * (1.0 / 1_000_000);
    const cachedCost = this._stats.cachedInputTokens * (0.1 / 1_000_000);
    const outputCost = this._stats.totalOutputTokens * (5.0 / 1_000_000);
    return {
      inputUSD: inputCost, cachedUSD: cachedCost, outputUSD: outputCost,
      totalUSD: inputCost + cachedCost + outputCost,
      savedUSD: this._stats.cachedInputTokens * (0.9 / 1_000_000)
    };
  }

  destroy() {
    this.cancelAll();
    this.clearHistory();
    this.clearTranslationCache();
    this.removeAllListeners();
  }
}

module.exports = { ClaudeClient, MODEL_HAIKU, MODEL_SONNET, LENGTH_MAP };
