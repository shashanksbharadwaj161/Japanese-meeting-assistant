// ============================================================================
// Answer Cache — Pre-Generated Answers with Fuzzy Matching
// ============================================================================
//
// Stores pre-generated interview answers in SQLite for offline use.
// During preflight, generates ~50 answers across 11 categories via Claude.
// During the interview, if all models fail, finds the closest cached answer.
//
// Categories (11):
//   1. self-introduction     6. salary-expectations
//   2. strengths             7. work-style
//   3. weaknesses            8. career-goals
//   4. motivation            9. team-experience
//   5. experience           10. problem-solving
//                           11. closing-questions
//
// Fuzzy matching uses keyword overlap + bigram similarity.
// Score > 0.6 returns a cached answer; below that returns null.
//
// Storage: SQLite table in the same sessions.db file.
// ============================================================================

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

// All 11 categories with their pre-generation question prompts
const CATEGORIES = {
  'self-introduction': [
    'Jiko shoukai wo onegai shimasu. (Please introduce yourself.)',
    'Kantan ni jiko shoukai wo shite kudasai. (Please give a brief self-introduction.)',
    'Kore made no keireki wo oshiete kudasai. (Please tell us about your career history.)',
    'Dou iu kata desuka? Jibun no seikaku wo oshiete kudasai. (What kind of person are you? Tell us about your personality.)',
    'Anata no keiken wo kantan ni setsumei shite kudasai. (Please briefly explain your experience.)'
  ],
  'strengths': [
    'Anata no tsuyomi wa nan desu ka? (What is your strength?)',
    'Jibun no ichiban no chouchou wa nan desu ka? (What is your best quality?)',
    'Dou iu tokoro ga kono shigoto ni tekishite iru to omoimasu ka? (Why do you think you are suited for this job?)',
    'Anata no tokui na koto wa nan desu ka? (What are you good at?)'
  ],
  'weaknesses': [
    'Anata no yowami wa nan desu ka? (What is your weakness?)',
    'Jibun no kadai wa nan da to omoimasu ka? (What do you think your challenges are?)',
    'Kaizen shitai tokoro wa arimasu ka? (Are there areas you want to improve?)',
    'Shippai shita keiken wo oshiete kudasai. (Tell us about a time you failed.)'
  ],
  'motivation': [
    'Naze kono kaisha wo kibou shimashita ka? (Why did you choose this company?)',
    'Shibou douki wo oshiete kudasai. (Please tell us your motivation for applying.)',
    'Kono shigoto no doko ni miryoku wo kanjimasu ka? (What attracts you to this job?)',
    'Naze ima no kaisha wo yametai no desu ka? (Why do you want to leave your current company?)',
    'Tenkin no riyuu wo oshiete kudasai. (Please tell us your reason for changing jobs.)'
  ],
  'experience': [
    'Ima made no shigoto no keiken wo oshiete kudasai. (Tell us about your work experience.)',
    'Mae no kaisha de donna shigoto wo shimashita ka? (What work did you do at your previous company?)',
    'Ichiban inshou ni nokotta purojekuto wa nan desu ka? (What project left the biggest impression?)',
    'Riidaashippu no keiken wa arimasu ka? (Do you have leadership experience?)',
    'Dono you na gijutsu/sukiru wo motte imasu ka? (What skills/technologies do you have?)'
  ],
  'salary-expectations': [
    'Kibou nenshuu wa ikura desu ka? (What is your desired annual salary?)',
    'Genkyuu wa ikura desu ka? (What is your current salary?)',
    'Kyuuyo ni tsuite nani ka kibou wa arimasu ka? (Do you have any preferences regarding salary?)'
  ],
  'work-style': [
    'Donna hatarakikata ga suki desu ka? (What work style do you prefer?)',
    'Zangyou ni tsuite dou omoimasu ka? (How do you feel about overtime?)',
    'Rimooto waaku ni tsuite dou omoimasu ka? (How do you feel about remote work?)',
    'Chiimu de hataraku no to hitori de hataraku no to dochira ga suki desu ka? (Do you prefer working in a team or alone?)'
  ],
  'career-goals': [
    'Gonen go no jibun wa dou natte itai desu ka? (Where do you see yourself in 5 years?)',
    'Shourai no mokuhyou wo oshiete kudasai. (Tell us your future goals.)',
    'Kono kaisha de donna kyaria wo kizukitai desu ka? (What kind of career do you want to build at this company?)',
    'Nagai me de mite donna shigoto wo shitai desu ka? (In the long term, what kind of work do you want to do?)'
  ],
  'team-experience': [
    'Chiimu de hataraku toki ni taisetsu ni shite iru koto wa nan desu ka? (What do you value when working in a team?)',
    'Iken ga awanai toki wa dou shimasu ka? (What do you do when opinions differ?)',
    'Jouji to no kankei wo dou kizukimasu ka? (How do you build relationships with superiors?)',
    'Chiimuwaku no keiken wo oshiete kudasai. (Tell us about your teamwork experience.)'
  ],
  'problem-solving': [
    'Muzukashii mondai ni chokumen shita toki dou shimasu ka? (What do you do when faced with a difficult problem?)',
    'Puressaa no naka de dou taiou shimasu ka? (How do you handle pressure?)',
    'Toraburu ga okita toki no taiou wo oshiete kudasai. (Tell us how you handle troubles.)',
    'Sutoresu kanri no houhou wo oshiete kudasai. (Tell us your stress management methods.)'
  ],
  'closing-questions': [
    'Nani ka shitsumon wa arimasu ka? (Do you have any questions?)',
    'Saigo ni nanika tsutaetai koto wa arimasu ka? (Is there anything you want to say lastly?)',
    'Itsu kara hatarakemasu ka? (When can you start working?)',
    'Hoka ni ukete iru kaisha wa arimasu ka? (Are you interviewing at other companies?)'
  ]
};

class AnswerCache extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dbPath     - Path to SQLite db (shared with session.js)
   * @param {import('./claude').ClaudeClient} options.claudeClient - For pre-generation
   */
  constructor(options = {}) {
    super();

    this._dbPath = options.dbPath || null;
    this._claudeClient = options.claudeClient || null;
    this._db = null;

    // In-memory lookup for fast matching during interview
    this._cache = new Map(); // key: question text, value: { answer, category, score keywords }

    this._stats = {
      totalEntries: 0,
      categoryCounts: {},
      preGenerated: 0,
      lookups: 0,
      hits: 0,
      misses: 0
    };
  }

  get stats() { return { ...this._stats }; }
  get size() { return this._cache.size; }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Initialize the cache table and load existing entries into memory.
   * @param {string} dbPath - Path to SQLite database
   */
  init(dbPath) {
    if (dbPath) this._dbPath = dbPath;
    if (!this._dbPath) throw new Error('No database path provided');

    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const Database = require('better-sqlite3');
    this._db = new Database(this._dbPath);

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS answer_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        keywords TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        profile_hash TEXT
      )
    `);

    this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cache_category ON answer_cache(category)
    `);

    // Load into memory
    this._loadIntoMemory();
  }

  _loadIntoMemory() {
    if (!this._db) return;

    const rows = this._db.prepare('SELECT * FROM answer_cache ORDER BY created_at DESC').all();
    this._cache.clear();

    for (const row of rows) {
      this._cache.set(row.question, {
        id: row.id,
        category: row.category,
        answer: row.answer,
        keywords: row.keywords ? row.keywords.split(',') : this._extractKeywords(row.question)
      });
    }

    this._stats.totalEntries = this._cache.size;

    // Count by category
    this._stats.categoryCounts = {};
    for (const [, entry] of this._cache) {
      this._stats.categoryCounts[entry.category] = (this._stats.categoryCounts[entry.category] || 0) + 1;
    }
  }

  // -----------------------------------------------------------------------
  // Pre-generation (called during preflight)
  // -----------------------------------------------------------------------

  /**
   * Pre-generate answers for all categories using Claude.
   * Emits 'pre-generate-progress' events for UI updates.
   *
   * @param {object} profile - Candidate profile
   * @param {object} context - Interview context
   * @returns {Promise<{generated, failed, total}>}
   */
  async preGenerate(profile, context) {
    if (!this._claudeClient?.isConfigured) {
      this.emit('pre-generate-progress', {
        status: 'skipped',
        message: 'Claude API not configured, skipping pre-generation'
      });
      return { generated: 0, failed: 0, total: 0 };
    }

    const allQuestions = [];
    for (const [category, questions] of Object.entries(CATEGORIES)) {
      for (const q of questions) {
        allQuestions.push({ category, question: q });
      }
    }

    let generated = 0;
    let failed = 0;
    const total = allQuestions.length;

    this.emit('pre-generate-progress', {
      status: 'started',
      total,
      generated: 0,
      message: `Pre-generating ${total} cached answers...`
    });

    // Process in batches of 3 to avoid rate limits
    for (let i = 0; i < allQuestions.length; i += 3) {
      const batch = allQuestions.slice(i, i + 3);

      const results = await Promise.allSettled(
        batch.map(async ({ category, question }) => {
          // Skip if already cached
          if (this._cache.has(question)) {
            return { category, question, answer: null, skipped: true };
          }

          const answer = await this._claudeClient.preGenerateAnswer(question, profile, context);
          return { category, question, answer };
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { category, question, answer, skipped } = result.value;
          if (skipped) {
            generated++; // Count pre-existing as "generated"
            continue;
          }
          if (answer) {
            this._storeAnswer(category, question, answer);
            generated++;
          }
        } else {
          failed++;
        }
      }

      this.emit('pre-generate-progress', {
        status: 'in-progress',
        total,
        generated,
        failed,
        percent: Math.round(((generated + failed) / total) * 100),
        message: `Pre-generated ${generated}/${total} answers...`
      });

      // Small delay between batches to respect rate limits
      if (i + 3 < allQuestions.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    this._stats.preGenerated = generated;

    this.emit('pre-generate-progress', {
      status: 'complete',
      total,
      generated,
      failed,
      message: `Pre-generation complete: ${generated} answers cached, ${failed} failed.`
    });

    return { generated, failed, total };
  }

  /**
   * Store a single answer in both SQLite and memory.
   */
  _storeAnswer(category, question, answer) {
    const keywords = this._extractKeywords(question);

    if (this._db) {
      const stmt = this._db.prepare(
        'INSERT OR REPLACE INTO answer_cache (category, question, answer, keywords) VALUES (?, ?, ?, ?)'
      );
      stmt.run(category, question, answer, keywords.join(','));
    }

    this._cache.set(question, { category, answer, keywords });
    this._stats.totalEntries = this._cache.size;
    this._stats.categoryCounts[category] = (this._stats.categoryCounts[category] || 0) + 1;
  }

  // -----------------------------------------------------------------------
  // Fuzzy matching — find best cached answer for a given transcript
  // -----------------------------------------------------------------------

  /**
   * Find the best matching cached answer for the given transcript.
   *
   * @param {string} transcript - The interview question
   * @returns {{answer, category, score, question}|null}
   */
  findBestMatch(transcript) {
    this._stats.lookups++;

    if (this._cache.size === 0) {
      this._stats.misses++;
      return null;
    }

    const queryKeywords = this._extractKeywords(transcript);
    const queryBigrams = this._getBigrams(transcript.toLowerCase());

    let bestScore = 0;
    let bestMatch = null;

    for (const [question, entry] of this._cache) {
      // Compute combined score: keyword overlap (60%) + bigram similarity (40%)
      const kwScore = this._keywordOverlap(queryKeywords, entry.keywords);
      const bgScore = this._bigramSimilarity(queryBigrams, this._getBigrams(question.toLowerCase()));
      const combined = kwScore * 0.6 + bgScore * 0.4;

      if (combined > bestScore) {
        bestScore = combined;
        bestMatch = { answer: entry.answer, category: entry.category, question, score: combined };
      }
    }

    if (bestScore > 0.6) {
      this._stats.hits++;
      return bestMatch;
    }

    // Try category-level fallback: detect category and return any from that category
    const detectedCategory = this._detectCategory(transcript);
    if (detectedCategory) {
      for (const [question, entry] of this._cache) {
        if (entry.category === detectedCategory) {
          this._stats.hits++;
          return {
            answer: entry.answer,
            category: entry.category,
            question,
            score: 0.61 // Just above threshold
          };
        }
      }
    }

    this._stats.misses++;
    return null;
  }

  // -----------------------------------------------------------------------
  // Text analysis helpers
  // -----------------------------------------------------------------------

  _extractKeywords(text) {
    // Remove romaji/Japanese particles and common words
    const stopwords = new Set([
      'wa', 'ga', 'no', 'ni', 'wo', 'de', 'to', 'ka', 'mo', 'ya',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would',
      'can', 'could', 'shall', 'should', 'may', 'might', 'must',
      'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my',
      'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she',
      'in', 'on', 'at', 'for', 'with', 'about', 'from', 'by',
      'please', 'tell', 'us', 'desu', 'masu', 'shite', 'kudasai',
      'oshiete', 'nan', 'dou', 'donna', 'what', 'how', 'when', 'where'
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w));
  }

  _keywordOverlap(keywords1, keywords2) {
    if (!keywords1.length || !keywords2.length) return 0;

    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);
    let matches = 0;

    for (const kw of set1) {
      if (set2.has(kw)) matches++;
    }

    // Jaccard similarity
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? matches / union.size : 0;
  }

  _getBigrams(text) {
    const clean = text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const bigrams = new Set();
    for (let i = 0; i < clean.length - 1; i++) {
      bigrams.add(clean.substring(i, i + 2));
    }
    return bigrams;
  }

  _bigramSimilarity(bigrams1, bigrams2) {
    if (bigrams1.size === 0 || bigrams2.size === 0) return 0;

    let matches = 0;
    for (const bg of bigrams1) {
      if (bigrams2.has(bg)) matches++;
    }

    const union = new Set([...bigrams1, ...bigrams2]);
    return union.size > 0 ? matches / union.size : 0;
  }

  /**
   * Detect which category a question belongs to based on keyword matching.
   */
  _detectCategory(transcript) {
    const lower = transcript.toLowerCase();

    const categoryKeywords = {
      'self-introduction': ['jiko shoukai', 'introduce', 'self-introduction', 'keireki', 'career history', 'tell me about yourself'],
      'strengths': ['tsuyomi', 'strength', 'strong point', 'best quality', 'tokui', 'good at'],
      'weaknesses': ['yowami', 'weakness', 'weak point', 'challenge', 'kadai', 'improve', 'shippai', 'failure'],
      'motivation': ['shibou douki', 'motivation', 'why this company', 'kibou', 'naze', 'why', 'reason for applying'],
      'experience': ['keiken', 'experience', 'previous job', 'project', 'skills', 'gijutsu', 'technology'],
      'salary-expectations': ['nenshuu', 'salary', 'kyuuyo', 'genkyuu', 'compensation', 'pay'],
      'work-style': ['hatarakikata', 'work style', 'zangyou', 'overtime', 'remote', 'rimooto', 'team or alone'],
      'career-goals': ['gonen go', 'five years', 'future', 'shourai', 'mokuhyou', 'goal', 'career'],
      'team-experience': ['chiimu', 'team', 'chiimuwaku', 'teamwork', 'iken', 'opinion', 'jouji', 'superior'],
      'problem-solving': ['mondai', 'problem', 'puressaa', 'pressure', 'toraburu', 'trouble', 'sutoresu', 'stress'],
      'closing-questions': ['shitsumon', 'question', 'saigo', 'last', 'itsu kara', 'when can you start', 'other companies']
    };

    let bestCategory = null;
    let bestCount = 0;

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      let count = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestCategory = category;
      }
    }

    return bestCount > 0 ? bestCategory : null;
  }

  // -----------------------------------------------------------------------
  // Manual cache operations
  // -----------------------------------------------------------------------

  /**
   * Add a custom answer to the cache (from user corrections etc.)
   */
  addAnswer(category, question, answer) {
    this._storeAnswer(category, question, answer);
  }

  /**
   * Get all cached answers for a specific category.
   */
  getByCategory(category) {
    const results = [];
    for (const [question, entry] of this._cache) {
      if (entry.category === category) {
        results.push({ question, answer: entry.answer, category });
      }
    }
    return results;
  }

  /**
   * Clear all cached answers.
   */
  clearAll() {
    if (this._db) {
      this._db.exec('DELETE FROM answer_cache');
    }
    this._cache.clear();
    this._stats.totalEntries = 0;
    this._stats.categoryCounts = {};
  }

  /**
   * Get all category names and their question counts.
   */
  getCategoryStats() {
    return { ...this._stats.categoryCounts };
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy() {
    if (this._db) {
      try { this._db.close(); } catch { /* ignore */ }
      this._db = null;
    }
    this._cache.clear();
    this.removeAllListeners();
  }
}

module.exports = { AnswerCache, CATEGORIES };
