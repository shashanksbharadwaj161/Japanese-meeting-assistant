// ============================================================================
// Fallback AI — Model Cascade with Offline Cache Last-Resort
// ============================================================================
//
// Cascade order (each step triggers only if the previous fails or times out):
//   1. claude-haiku-4-5    (primary — fast, cheap)
//   2. claude-sonnet-4-6   (fallback 1 — better quality, more expensive)
//   3. GPT-4o-mini         (fallback 2 — only if OpenAI key configured)
//   4. Offline cache        (last resort — pre-generated answers via fuzzy match)
//
// Each model attempt has a 4-second timeout via AbortController.
// On failure, the next model is tried immediately.
//
// Events:
//   'fallback-activated'  — switched away from primary model
//   'fallback-recovered'  — primary model restored after being down
//   'model-attempt'       — each model attempt (for logging)
//   'answer-chunk'        — streaming token (proxied from ClaudeClient)
//
// Usage:
//   const fallback = new FallbackAI({ claudeClient, cacheManager, openaiKey });
//   const result = await fallback.generateAnswer(transcript, config);
// ============================================================================

const { EventEmitter } = require('events');

const MODEL_HAIKU = 'claude-haiku-4-5';
const MODEL_SONNET = 'claude-sonnet-4-6';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const ATTEMPT_TIMEOUT_MS = 4000;
const RESTORE_CHECK_INTERVAL_MS = 60000; // Check if primary recovered every 60s

class FallbackAI extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./claude').ClaudeClient} options.claudeClient  - Existing Claude client
   * @param {import('./cache').AnswerCache}   options.cacheManager   - Offline answer cache
   * @param {string}                          options.openaiKey      - OpenAI API key (optional)
   * @param {object}                          options.profile        - Candidate profile for system prompt
   * @param {object}                          options.context        - Interview context for system prompt
   */
  constructor(options = {}) {
    super();

    this._claudeClient = options.claudeClient || null;
    this._cacheManager = options.cacheManager || null;
    this._openaiKey = options.openaiKey || '';
    this._profile = options.profile || {};
    this._context = options.context || {};

    // Track which model is currently active
    this._activeModel = MODEL_HAIKU;
    this._primaryModel = MODEL_HAIKU;
    this._isFallback = false;

    // Track model health
    this._modelHealth = {
      [MODEL_HAIKU]: { available: true, lastError: null, consecutiveFailures: 0 },
      [MODEL_SONNET]: { available: true, lastError: null, consecutiveFailures: 0 },
      [OPENAI_MODEL]: { available: !!options.openaiKey, lastError: null, consecutiveFailures: 0 }
    };

    // Periodic check to see if primary has recovered
    this._restoreTimer = null;

    // Stats
    this._stats = {
      totalAttempts: 0,
      haiku: { attempts: 0, successes: 0, failures: 0 },
      sonnet: { attempts: 0, successes: 0, failures: 0 },
      openai: { attempts: 0, successes: 0, failures: 0 },
      cache: { attempts: 0, hits: 0, misses: 0 },
      fallbackActivations: 0,
      primaryRestorations: 0
    };
  }

  /** Currently active model name */
  get activeModel() { return this._activeModel; }

  /** Whether the system is running on a fallback model */
  get isUsingFallback() { return this._isFallback; }

  /** Model health status for UI display */
  get modelHealth() { return { ...this._modelHealth }; }

  /** Stats snapshot */
  get stats() { return JSON.parse(JSON.stringify(this._stats)); }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  setOpenAIKey(key) {
    this._openaiKey = key || '';
    this._modelHealth[OPENAI_MODEL].available = !!key;
  }

  setClaudeClient(client) {
    this._claudeClient = client;
  }

  setCacheManager(cache) {
    this._cacheManager = cache;
  }

  setProfile(profile) { this._profile = profile; }
  setContext(context) { this._context = context; }

  // -----------------------------------------------------------------------
  // Start / Stop restore monitoring
  // -----------------------------------------------------------------------

  startMonitoring() {
    if (this._restoreTimer) return;
    this._restoreTimer = setInterval(() => {
      this._tryRestorePrimary();
    }, RESTORE_CHECK_INTERVAL_MS);
  }

  stopMonitoring() {
    if (this._restoreTimer) {
      clearInterval(this._restoreTimer);
      this._restoreTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Main entry: generate answer with full cascade
  // -----------------------------------------------------------------------

  /**
   * Generate an answer, cascading through models on failure.
   *
   * @param {string} transcript - The interview question/transcript
   * @param {object} config     - { length, variation, streaming }
   * @returns {Promise<{answer, model, fromCache, usage}>}
   */
  async generateAnswer(transcript, config = {}) {
    this._stats.totalAttempts++;

    const cascade = this._buildCascade();

    for (const step of cascade) {
      this.emit('model-attempt', { model: step.name, transcript });

      try {
        const result = await step.fn(transcript, config);
        if (result && result.answer) {
          // Successful — update model tracking
          this._recordSuccess(step.name);

          if (step.name !== this._primaryModel && !this._isFallback) {
            this._isFallback = true;
            this._activeModel = step.name;
            this._stats.fallbackActivations++;
            this.emit('fallback-activated', {
              activeModel: step.name,
              primaryModel: this._primaryModel,
              reason: `Primary model ${this._primaryModel} unavailable`
            });
            this.startMonitoring();
          } else if (step.name === this._primaryModel) {
            this._activeModel = step.name;
          }

          return result;
        }
      } catch (err) {
        this._recordFailure(step.name, err);
        // Continue to next step in cascade
      }
    }

    // All models + cache failed
    return {
      answer: this._getEmergencyResponse(transcript),
      model: 'emergency-template',
      fromCache: false,
      usage: null,
      warning: 'All AI models and cache failed. Using emergency template.'
    };
  }

  // -----------------------------------------------------------------------
  // Cascade builder
  // -----------------------------------------------------------------------

  _buildCascade() {
    const steps = [];

    // Step 1: Haiku (primary)
    if (this._claudeClient?.isConfigured) {
      steps.push({
        name: MODEL_HAIKU,
        fn: (transcript, config) => this._tryClaudeModel(transcript, config, MODEL_HAIKU)
      });
    }

    // Step 2: Sonnet (fallback 1)
    if (this._claudeClient?.isConfigured) {
      steps.push({
        name: MODEL_SONNET,
        fn: (transcript, config) => this._tryClaudeModel(transcript, config, MODEL_SONNET)
      });
    }

    // Step 3: GPT-4o-mini (fallback 2)
    if (this._openaiKey) {
      steps.push({
        name: OPENAI_MODEL,
        fn: (transcript, config) => this._tryOpenAI(transcript, config)
      });
    }

    // Step 4: Offline cache (last resort)
    if (this._cacheManager) {
      steps.push({
        name: 'offline-cache',
        fn: (transcript) => this._tryCache(transcript)
      });
    }

    return steps;
  }

  // -----------------------------------------------------------------------
  // Model attempt: Claude (Haiku or Sonnet)
  // -----------------------------------------------------------------------

  async _tryClaudeModel(transcript, config, model) {
    const statKey = model === MODEL_HAIKU ? 'haiku' : 'sonnet';
    this._stats[statKey].attempts++;

    // Use the existing ClaudeClient with model override
    const result = await this._claudeClient.generateAnswer(transcript, {
      ...config,
      model
    });

    this._stats[statKey].successes++;
    return {
      answer: result.answer,
      model,
      fromCache: false,
      usage: result.usage,
      cacheHit: result.cacheHit
    };
  }

  // -----------------------------------------------------------------------
  // Model attempt: GPT-4o-mini
  // -----------------------------------------------------------------------

  async _tryOpenAI(transcript, config) {
    this._stats.openai.attempts++;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

    try {
      const systemPrompt = this._buildOpenAISystemPrompt();

      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._openaiKey}`
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          max_tokens: 500,
          temperature: 0.7,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Interview question:\n${transcript}\n\nProvide a coached answer in the exact format specified.`
            }
          ]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();

      if (!answer) throw new Error('Empty response from OpenAI');

      this._stats.openai.successes++;
      return {
        answer,
        model: OPENAI_MODEL,
        fromCache: false,
        usage: data.usage ? {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens
        } : null
      };

    } catch (err) {
      clearTimeout(timeoutId);
      this._stats.openai.failures++;
      throw err;
    }
  }

  /**
   * Build an OpenAI-compatible system prompt (same content as Claude, different format).
   */
  _buildOpenAISystemPrompt() {
    const profile = this._profile;
    const context = this._context;

    return [
      'You are a real-time interview coaching assistant for Japanese/English bilingual interviews.',
      'You generate answers the candidate can READ ALOUD in real-time during a live interview.',
      '',
      '=== CANDIDATE PROFILE ===',
      `JLPT Level: ${profile.level || 'N3'}`,
      `Speaking style: ${profile.style || 'polite'}`,
      `Output format: ${profile.format || 'romaji'}`,
      `Tone: ${profile.tone || 'humble'}`,
      `Answer length: 4-5 sentences`,
      '',
      '=== INTERVIEW CONTEXT ===',
      context.company ? `Company: ${context.company}` : '',
      context.interviewType ? `Interview type: ${context.interviewType}` : '',
      context.jobDescription ? `Job description:\n${context.jobDescription}` : '',
      context.resume ? `Candidate background:\n${context.resume}` : '',
      '',
      '=== OUTPUT FORMAT (STRICT) ===',
      'EN: [Natural English translation of the question]',
      '',
      '[romaji line 1]',
      '-> [English meaning of line 1]',
      '',
      '[romaji line 2]',
      '-> [English meaning of line 2]',
      '',
      '=== RULES ===',
      '1. SPOKEN WORD: Write how a real person talks.',
      '2. VOCABULARY: Use only N3/N4 level words.',
      '3. SHORT SENTENCES: Each romaji line readable in one breath.',
      '4. CULTURALLY APPROPRIATE: Use humble framing (kenjougo).',
      '5. ROMAJI: Standard Hepburn romanization. Particles separated by spaces.',
      '6. Each -> subtitle: natural English equivalent, not word-for-word.',
      '7. No explanations, no alternatives. Just the formatted answer.'
    ].filter(Boolean).join('\n');
  }

  // -----------------------------------------------------------------------
  // Cache attempt (offline last-resort)
  // -----------------------------------------------------------------------

  async _tryCache(transcript) {
    this._stats.cache.attempts++;

    const match = this._cacheManager.findBestMatch(transcript);
    if (match && match.score > 0.6) {
      this._stats.cache.hits++;
      return {
        answer: match.answer,
        model: 'offline-cache',
        fromCache: true,
        usage: null,
        cacheScore: match.score,
        cacheCategory: match.category,
        warning: 'Using pre-generated cached answer. May not perfectly match the question.'
      };
    }

    this._stats.cache.misses++;
    throw new Error('No suitable cached answer found');
  }

  // -----------------------------------------------------------------------
  // Primary restoration
  // -----------------------------------------------------------------------

  async _tryRestorePrimary() {
    if (!this._isFallback || !this._claudeClient?.isConfigured) return;

    try {
      // Quick health check: send a tiny classification request
      const result = await Promise.race([
        this._claudeClient.classifyQuestion('test'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);

      // If we got here, the primary model is responsive
      if (result) {
        const previousModel = this._activeModel;
        this._activeModel = this._primaryModel;
        this._isFallback = false;
        this._modelHealth[this._primaryModel].available = true;
        this._modelHealth[this._primaryModel].consecutiveFailures = 0;
        this._stats.primaryRestorations++;

        this.emit('fallback-recovered', {
          activeModel: this._primaryModel,
          previousModel,
          message: `Primary model ${this._primaryModel} restored`
        });

        this.stopMonitoring();
      }
    } catch {
      // Primary still down — keep monitoring
    }
  }

  // -----------------------------------------------------------------------
  // Health tracking
  // -----------------------------------------------------------------------

  _recordSuccess(modelName) {
    const health = this._modelHealth[modelName];
    if (health) {
      health.available = true;
      health.consecutiveFailures = 0;
      health.lastError = null;
    }
  }

  _recordFailure(modelName, error) {
    const health = this._modelHealth[modelName];
    if (health) {
      health.consecutiveFailures++;
      health.lastError = error.message;
      if (health.consecutiveFailures >= 3) {
        health.available = false;
      }
    }

    const statKey = modelName === MODEL_HAIKU ? 'haiku'
      : modelName === MODEL_SONNET ? 'sonnet'
      : modelName === OPENAI_MODEL ? 'openai'
      : null;
    if (statKey) this._stats[statKey].failures++;
  }

  // -----------------------------------------------------------------------
  // Emergency response (absolute last resort — template-based)
  // -----------------------------------------------------------------------

  _getEmergencyResponse(transcript) {
    const type = this._detectQuestionType(transcript);
    const templates = {
      selfIntro: [
        'EN: Please introduce yourself.',
        '',
        'Hajimemashite. Watashi wa [name] to moushimasu.',
        '→ Nice to meet you. My name is [name].',
        '',
        'Mae no kaisha de [years] nenkan hataraite imashita.',
        '→ I worked at my previous company for [years] years.',
        '',
        'Kisha de jibun no keiken wo ikashitai to omoimasu.',
        '→ I would like to put my experience to use at your company.',
        '',
        'Yoroshiku onegai itashimasu.',
        '→ Thank you for your consideration.'
      ],
      strength: [
        'EN: What is your strength?',
        '',
        'Watashi no tsuyomi wa [skill] desu.',
        '→ My strength is [skill].',
        '',
        'Mae no shigoto de [example] no keiken ga arimasu.',
        '→ At my previous job I have experience with [example].',
        '',
        'Kono keiken wo kisha de ikashitai desu.',
        '→ I want to apply this experience at your company.'
      ],
      weakness: [
        'EN: What is your weakness?',
        '',
        'Watashi no kadai wa [weakness] desu.',
        '→ My challenge is [weakness].',
        '',
        'Demo, sore wo kaizen suru tame ni mainichi doryoku shite imasu.',
        '→ But I make daily efforts to improve on it.',
        '',
        'Tatoeba, [action] wo hajimemashita.',
        '→ For example, I started [action].'
      ],
      motivation: [
        'EN: Why do you want to work here?',
        '',
        'Kisha no [feature] ni totemo kyoumi ga arimasu.',
        '→ I am very interested in your company\'s [feature].',
        '',
        'Watashi no [skill] de kouken dekiru to omoimasu.',
        '→ I believe I can contribute with my [skill].',
        '',
        'Zehi issho ni hatarakitai desu.',
        '→ I really want to work together.'
      ],
      general: [
        'EN: [Please answer this question]',
        '',
        'Hai, sou desu ne.',
        '→ Yes, let me think.',
        '',
        'Watashi wa sono ten ni tsuite keiken ga arimasu.',
        '→ I have experience regarding that point.',
        '',
        'Kuwashiku setsumei sasete itadakimasu.',
        '→ Please allow me to explain in detail.'
      ]
    };

    const lines = templates[type] || templates.general;
    return lines.join('\n');
  }

  _detectQuestionType(transcript) {
    const lower = (transcript || '').toLowerCase();
    if (lower.includes('jiko shoukai') || lower.includes('introduce') || lower.includes('tell me about yourself'))
      return 'selfIntro';
    if (lower.includes('tsuyomi') || lower.includes('strength') || lower.includes('strong point'))
      return 'strength';
    if (lower.includes('yowami') || lower.includes('weakness') || lower.includes('weak point') || lower.includes('challenge'))
      return 'weakness';
    if (lower.includes('shibou douki') || lower.includes('why') || lower.includes('motivation') || lower.includes('reason'))
      return 'motivation';
    return 'general';
  }

  // -----------------------------------------------------------------------
  // Public getters for UI status display
  // -----------------------------------------------------------------------

  getActiveModel() {
    return this._activeModel;
  }

  getModelStatus() {
    return {
      activeModel: this._activeModel,
      isFallback: this._isFallback,
      health: this._modelHealth,
      stats: this._stats
    };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy() {
    this.stopMonitoring();
    this.removeAllListeners();
  }
}

module.exports = { FallbackAI, MODEL_HAIKU, MODEL_SONNET, OPENAI_MODEL };
