// ============================================================================
// Session Storage — SQLite Transcript + AI Response Storage + Report Gen
// ============================================================================
//
// Tables:
//   sessions     — one row per interview session
//   transcripts  — every transcript line (JP text, EN text, romaji, provider)
//   ai_responses — every AI-generated answer (linked to transcript)
//   reports      — generated post-interview reports (JSON + markdown)
//
// Transcript entry format:
//   { timestamp, speaker, jpText, enText, romajiAnswer, enAnswer,
//     language, provider, confidence, isQuestion }
//
// Report generation uses Claude Sonnet 4.6 via ClaudeClient.generateReport()
// Export formats: .md (report) and .txt (raw transcript)
//
// Storage location: beside .exe (portable) or userData
// ============================================================================

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let db = null;

// -----------------------------------------------------------------------
// Database path + initialization
// -----------------------------------------------------------------------

function getDbPath() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const base = portableDir || app.getPath('userData');
  const dir = path.join(base, 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'sessions.db');
}

function getExportDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const base = portableDir || app.getPath('userData');
  const dir = path.join(base, 'exports');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function initDatabase() {
  if (db) return db;

  const Database = require('better-sqlite3');
  db = new Database(getDbPath());

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      company TEXT,
      interview_type TEXT,
      job_title TEXT,
      notes TEXT,
      duration_seconds INTEGER,
      total_questions INTEGER DEFAULT 0,
      total_answers INTEGER DEFAULT 0,
      report_json TEXT,
      report_markdown TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      timestamp_ms INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      speaker TEXT NOT NULL DEFAULT 'interviewer',
      jp_text TEXT,
      en_text TEXT,
      romaji_answer TEXT,
      en_answer TEXT,
      language TEXT,
      provider TEXT,
      confidence REAL,
      is_question INTEGER DEFAULT 0,
      is_statement INTEGER DEFAULT 0,
      offline_mode INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      transcript_id INTEGER,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      response_text TEXT NOT NULL,
      model TEXT,
      from_cache INTEGER DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      response_time_ms INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      report_json TEXT NOT NULL,
      report_markdown TEXT,
      model TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_responses_session ON ai_responses(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id)`);

  return db;
}

// -----------------------------------------------------------------------
// Session CRUD
// -----------------------------------------------------------------------

function createSession(company, interviewType, jobTitle) {
  const database = initDatabase();
  const stmt = database.prepare(
    'INSERT INTO sessions (company, interview_type, job_title) VALUES (?, ?, ?)'
  );
  const result = stmt.run(company || '', interviewType || '', jobTitle || '');
  return result.lastInsertRowid;
}

function endSession(sessionId) {
  const database = initDatabase();

  // Calculate duration
  const session = database.prepare('SELECT started_at FROM sessions WHERE id = ?').get(sessionId);
  let durationSeconds = 0;
  if (session) {
    const started = new Date(session.started_at + 'Z');
    durationSeconds = Math.round((Date.now() - started.getTime()) / 1000);
  }

  // Count questions and answers
  const qCount = database.prepare(
    'SELECT COUNT(*) as cnt FROM transcripts WHERE session_id = ? AND is_question = 1'
  ).get(sessionId);
  const aCount = database.prepare(
    'SELECT COUNT(*) as cnt FROM ai_responses WHERE session_id = ?'
  ).get(sessionId);

  database.prepare(
    `UPDATE sessions SET
      ended_at = datetime('now'),
      duration_seconds = ?,
      total_questions = ?,
      total_answers = ?
    WHERE id = ?`
  ).run(durationSeconds, qCount?.cnt || 0, aCount?.cnt || 0, sessionId);

  return { sessionId, durationSeconds, totalQuestions: qCount?.cnt || 0, totalAnswers: aCount?.cnt || 0 };
}

function getSession(sessionId) {
  const database = initDatabase();
  return database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function listSessions(limit = 20) {
  const database = initDatabase();
  return database.prepare(
    'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'
  ).all(limit);
}

// -----------------------------------------------------------------------
// Transcript storage
// -----------------------------------------------------------------------

/**
 * Save a transcript entry.
 *
 * @param {number} sessionId
 * @param {object} data
 * @param {string} data.speaker      - 'interviewer' | 'candidate'
 * @param {string} data.jpText       - Original Japanese text
 * @param {string} data.enText       - English translation
 * @param {string} data.romajiAnswer - Romaji answer (if AI-generated)
 * @param {string} data.enAnswer     - English subtitle of answer
 * @param {string} data.language     - Detected language
 * @param {string} data.provider     - STT provider used
 * @param {number} data.confidence   - STT confidence score
 * @param {boolean} data.isQuestion  - Whether this was classified as a question
 * @param {boolean} data.isStatement - Whether this was classified as a statement
 * @param {boolean} data.offlineMode - Whether transcribed offline
 * @returns {number} transcript row id
 */
function saveTranscript(sessionId, data) {
  const database = initDatabase();
  const stmt = database.prepare(`
    INSERT INTO transcripts
      (session_id, speaker, jp_text, en_text, romaji_answer, en_answer,
       language, provider, confidence, is_question, is_statement, offline_mode, timestamp_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionId,
    data.speaker || 'interviewer',
    data.jpText || data.text || null,
    data.enText || null,
    data.romajiAnswer || null,
    data.enAnswer || null,
    data.language || null,
    data.provider || null,
    data.confidence || null,
    data.isQuestion ? 1 : 0,
    data.isStatement ? 1 : 0,
    data.offlineMode ? 1 : 0,
    Date.now()
  );

  return result.lastInsertRowid;
}

/**
 * Save an AI response linked to a transcript entry.
 */
function saveAIResponse(sessionId, data) {
  const database = initDatabase();
  const stmt = database.prepare(`
    INSERT INTO ai_responses
      (session_id, transcript_id, response_text, model, from_cache,
       input_tokens, output_tokens, cached_tokens, response_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionId,
    data.transcriptId || null,
    data.responseText || data.response || '',
    data.model || null,
    data.fromCache ? 1 : 0,
    data.inputTokens || null,
    data.outputTokens || null,
    data.cachedTokens || null,
    data.responseTimeMs || null
  );

  return result.lastInsertRowid;
}

/**
 * Get the full transcript for a session, ordered by time.
 */
function getFullTranscript(sessionId) {
  const database = initDatabase();
  return database.prepare(`
    SELECT
      t.*,
      a.response_text as ai_response,
      a.model as ai_model,
      a.from_cache as ai_from_cache
    FROM transcripts t
    LEFT JOIN ai_responses a ON a.transcript_id = t.id
    WHERE t.session_id = ?
    ORDER BY t.timestamp_ms ASC
  `).all(sessionId);
}

/**
 * Get only question transcripts with their AI responses.
 */
function getQuestionsAndAnswers(sessionId) {
  const database = initDatabase();
  return database.prepare(`
    SELECT
      t.id, t.timestamp, t.jp_text, t.en_text, t.language, t.confidence,
      a.response_text as ai_response, a.model, a.from_cache
    FROM transcripts t
    LEFT JOIN ai_responses a ON a.transcript_id = t.id
    WHERE t.session_id = ? AND t.is_question = 1
    ORDER BY t.timestamp_ms ASC
  `).all(sessionId);
}

// -----------------------------------------------------------------------
// Report generation
// -----------------------------------------------------------------------

/**
 * Generate a post-interview report using Claude Sonnet.
 *
 * @param {number} sessionId
 * @param {import('../ai/claude').ClaudeClient} claudeClient
 * @returns {Promise<object>} Report object with scores and analysis
 */
async function generateReport(sessionId, claudeClient) {
  const database = initDatabase();

  const session = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const transcript = getFullTranscript(sessionId);
  if (transcript.length === 0) throw new Error('No transcript data for this session');

  // Format transcript for Claude
  const formattedTranscript = transcript.map(t => ({
    timestamp: t.timestamp,
    speaker: t.speaker,
    jpText: t.jp_text,
    enText: t.en_text,
    text: t.jp_text || t.en_text || ''
  }));

  const sessionMeta = {
    company: session.company,
    interviewType: session.interview_type,
    jobTitle: session.job_title,
    date: session.started_at ? session.started_at.split('T')[0] : new Date().toISOString().split('T')[0],
    durationSeconds: session.duration_seconds
  };

  // Call Claude Sonnet for analysis
  const report = await claudeClient.generateReport(formattedTranscript, sessionMeta);

  // Add session-level stats
  report.sessionStats = {
    duration: formatDuration(session.duration_seconds || 0),
    totalQuestions: session.total_questions,
    totalAnswers: session.total_answers,
    transcriptLines: transcript.length
  };

  // Generate markdown version
  const markdown = buildReportMarkdown(report, sessionMeta);

  // Save to database
  const existing = database.prepare('SELECT id FROM reports WHERE session_id = ?').get(sessionId);
  if (existing) {
    database.prepare(
      'UPDATE reports SET report_json = ?, report_markdown = ?, model = ? WHERE session_id = ?'
    ).run(JSON.stringify(report), markdown, 'claude-sonnet-4-6', sessionId);
  } else {
    database.prepare(
      'INSERT INTO reports (session_id, report_json, report_markdown, model) VALUES (?, ?, ?, ?)'
    ).run(sessionId, JSON.stringify(report), markdown, 'claude-sonnet-4-6');
  }

  // Also store in sessions table for quick access
  database.prepare(
    'UPDATE sessions SET report_json = ?, report_markdown = ? WHERE id = ?'
  ).run(JSON.stringify(report), markdown, sessionId);

  return { report, markdown };
}

/**
 * Get a previously generated report.
 */
function getReport(sessionId) {
  const database = initDatabase();
  const row = database.prepare('SELECT * FROM reports WHERE session_id = ?').get(sessionId);
  if (!row) return null;

  return {
    report: JSON.parse(row.report_json),
    markdown: row.report_markdown,
    createdAt: row.created_at,
    model: row.model
  };
}

// -----------------------------------------------------------------------
// Report markdown builder
// -----------------------------------------------------------------------

function buildReportMarkdown(report, meta) {
  const lines = [];

  lines.push(`# Interview Report`);
  lines.push('');
  lines.push(`**Company:** ${meta.company || 'N/A'}`);
  lines.push(`**Position:** ${meta.jobTitle || meta.interviewType || 'N/A'}`);
  lines.push(`**Date:** ${meta.date || 'N/A'}`);
  if (report.sessionStats) {
    lines.push(`**Duration:** ${report.sessionStats.duration}`);
    lines.push(`**Questions Asked:** ${report.sessionStats.totalQuestions}`);
    lines.push(`**Answers Generated:** ${report.sessionStats.totalAnswers}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary
  if (report.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(report.summary);
    lines.push('');
  }

  // Scores
  lines.push('## Scores');
  lines.push('');
  if (report.fluencyScore != null) {
    lines.push(`- **Fluency:** ${report.fluencyScore}/10`);
  }
  if (report.culturalScore != null) {
    lines.push(`- **Cultural Appropriateness:** ${report.culturalScore}/10`);
  }
  if (report.vocabularyAssessment) {
    lines.push(`- **Vocabulary:** ${report.vocabularyAssessment}`);
  }
  lines.push('');

  // Things that went well
  if (report.thingsWentWell && report.thingsWentWell.length > 0) {
    lines.push('## Things That Went Well');
    lines.push('');
    for (const item of report.thingsWentWell) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Areas to improve
  if (report.areasToImprove && report.areasToImprove.length > 0) {
    lines.push('## Areas to Improve');
    lines.push('');
    for (const item of report.areasToImprove) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Questions and answers analysis
  if (report.questionsAsked && report.questionsAsked.length > 0) {
    lines.push('## Question-by-Question Analysis');
    lines.push('');
    for (let i = 0; i < report.questionsAsked.length; i++) {
      const qa = report.questionsAsked[i];
      lines.push(`### Q${i + 1}: ${qa.jp || ''}`);
      if (qa.en) lines.push(`*(${qa.en})*`);
      lines.push('');
      if (qa.yourAnswer) {
        lines.push(`**Your Answer:** ${qa.yourAnswer}`);
        lines.push('');
      }
      if (qa.betterAnswer) {
        lines.push(`**Suggested Improvement:** ${qa.betterAnswer}`);
        lines.push('');
      }
    }
  }

  // Study recommendations
  if (report.recommendedStudyTopics && report.recommendedStudyTopics.length > 0) {
    lines.push('## Recommended Study Topics');
    lines.push('');
    for (const topic of report.recommendedStudyTopics) {
      lines.push(`- ${topic}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Report generated by Interview Assistant using Claude Sonnet 4.6*');

  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Export functions
// -----------------------------------------------------------------------

/**
 * Export report as a .md file.
 * @returns {string} File path of exported report
 */
function exportReport(sessionId) {
  const database = initDatabase();
  const session = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);

  // Try to get existing report markdown
  let markdown;
  const reportRow = database.prepare('SELECT report_markdown FROM reports WHERE session_id = ?').get(sessionId);
  if (reportRow && reportRow.report_markdown) {
    markdown = reportRow.report_markdown;
  } else if (session && session.report_markdown) {
    markdown = session.report_markdown;
  } else {
    throw new Error('No report found for this session. Generate a report first.');
  }

  const dateStr = (session?.started_at || new Date().toISOString()).split('T')[0].replace(/-/g, '');
  const company = (session?.company || 'interview').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const filename = `report_${dateStr}_${company}.md`;
  const filePath = path.join(getExportDir(), filename);

  fs.writeFileSync(filePath, markdown, 'utf-8');
  return filePath;
}

/**
 * Export raw transcript as a .txt file.
 * @returns {string} File path of exported transcript
 */
function exportTranscript(sessionId) {
  const database = initDatabase();
  const session = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const transcript = getFullTranscript(sessionId);

  if (transcript.length === 0) throw new Error('No transcript data for this session');

  const lines = [];
  lines.push(`Interview Transcript`);
  lines.push(`Company: ${session?.company || 'N/A'}`);
  lines.push(`Date: ${session?.started_at || 'N/A'}`);
  lines.push(`Duration: ${formatDuration(session?.duration_seconds || 0)}`);
  lines.push('='.repeat(60));
  lines.push('');

  for (const t of transcript) {
    const time = t.timestamp || '';
    const speaker = (t.speaker || 'unknown').toUpperCase();
    const jpText = t.jp_text || '';
    const enText = t.en_text || '';

    lines.push(`[${time}] ${speaker}:`);
    if (jpText) lines.push(`  JP: ${jpText}`);
    if (enText) lines.push(`  EN: ${enText}`);

    if (t.ai_response) {
      lines.push(`  AI ANSWER:`);
      for (const answerLine of t.ai_response.split('\n')) {
        lines.push(`    ${answerLine}`);
      }
    }

    lines.push('');
  }

  const dateStr = (session?.started_at || new Date().toISOString()).split('T')[0].replace(/-/g, '');
  const company = (session?.company || 'interview').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const filename = `transcript_${dateStr}_${company}.txt`;
  const filePath = path.join(getExportDir(), filename);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function closeDatabase() {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

module.exports = {
  initDatabase,
  getDbPath,
  createSession,
  endSession,
  getSession,
  listSessions,
  saveTranscript,
  saveAIResponse,
  getFullTranscript,
  getQuestionsAndAnswers,
  generateReport,
  getReport,
  exportReport,
  exportTranscript,
  closeDatabase
};
