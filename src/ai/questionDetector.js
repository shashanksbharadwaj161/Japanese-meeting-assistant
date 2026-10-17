// ============================================================================
// Question Detector — Local heuristics only, zero API calls
// ============================================================================
// Detects if a transcript is an interview question that needs an answer.
// Uses Japanese grammar patterns + English keyword patterns.
// In interview context, defaults to "yes" if unsure (better to over-answer).
// ============================================================================

'use strict';

// Japanese question-ending patterns
const JP_QUESTION_ENDINGS = [
  'ですか', 'ますか', 'でしょうか', 'かな', 'ません か',
  'くれますか', 'いただけますか', 'もらえますか',
  'ないですか', 'のですか', 'んですか',
  'てください', 'お願いします', 'ください',
  'を教えてください', 'を聞かせてください',
  'について教えて', 'について聞かせて',
];

// Japanese question marker
const JP_QUESTION_MARK = '？';

// Romaji question-ending patterns (for romaji transcripts)
const ROMAJI_QUESTION = [
  'desu ka', 'masu ka', 'deshou ka', 'kana',
  'kudasai', 'onegai shimasu', 'oshiete',
  'kikasete',
];

// English question starters
const EN_QUESTION_STARTS = [
  'what ', 'why ', 'how ', 'where ', 'when ', 'who ',
  'which ', 'could you', 'can you', 'would you',
  'do you', 'did you', 'have you', 'are you', 'were you',
  'tell me', 'tell us', 'describe', 'explain',
  'please tell', 'please describe', 'please explain',
];

// Interview-specific trigger phrases (high confidence = question)
const INTERVIEW_TRIGGERS = [
  '自己紹介', 'jiko shoukai', 'self-introduction', 'introduce yourself',
  '強み', 'tsuyomi', 'strength',
  '弱み', 'yowami', 'weakness',
  '志望動機', 'shibou douki', 'motivation',
  '経験', 'keiken', 'experience',
  '目標', 'mokuhyou', 'goal',
  '将来', 'shourai', 'future',
  '質問', 'shitsumon', 'question',
  'career', 'salary', 'team', 'leadership',
  'challenge', 'problem', 'stress',
];

// Greeting/filler patterns (NOT questions)
const GREETINGS = [
  'こんにちは', 'おはようございます', 'お疲れ様',
  'はい', 'ええ', 'うん', 'そうですね', 'なるほど',
  'hello', 'hi', 'good morning', 'thank you', 'thanks',
  'I see', 'okay', 'right', 'sure', 'yes', 'no',
  'ありがとう', '失礼します', 'よろしく',
];

/**
 * Detect if text is an interview question.
 * Returns { isQuestion: boolean, confidence: number, reason: string }
 *
 * confidence: 0.0–1.0
 *   > 0.7 = definitely a question
 *   0.4–0.7 = probably a question (interview context → answer anyway)
 *   < 0.4 = probably not a question
 */
function detect(text) {
  if (!text || text.trim().length < 2) {
    return { isQuestion: false, confidence: 0, reason: 'empty' };
  }

  const t = text.trim();
  const lower = t.toLowerCase();
  let score = 0;
  let reason = '';

  // Check if it's just a greeting/filler (short, common phrase)
  for (const g of GREETINGS) {
    if (lower === g || lower === g + '。' || lower === g + '.') {
      return { isQuestion: false, confidence: 0.1, reason: 'greeting' };
    }
  }

  // Very short text (< 4 chars) = likely not a question
  if (t.length < 4) {
    return { isQuestion: false, confidence: 0.1, reason: 'too-short' };
  }

  // Japanese question mark
  if (t.includes(JP_QUESTION_MARK) || t.includes('?')) {
    score += 0.6;
    reason = 'question-mark';
  }

  // Japanese question endings
  for (const ending of JP_QUESTION_ENDINGS) {
    if (t.endsWith(ending) || t.includes(ending + '。') || t.includes(ending + '？')) {
      score += 0.5;
      reason = reason || 'jp-grammar';
      break;
    }
  }

  // Romaji question patterns
  for (const pat of ROMAJI_QUESTION) {
    if (lower.includes(pat)) {
      score += 0.4;
      reason = reason || 'romaji-pattern';
      break;
    }
  }

  // English question starters
  for (const starter of EN_QUESTION_STARTS) {
    if (lower.startsWith(starter)) {
      score += 0.6;
      reason = reason || 'en-question';
      break;
    }
  }

  // Interview trigger words (boost score)
  for (const trigger of INTERVIEW_TRIGGERS) {
    if (lower.includes(trigger)) {
      score += 0.3;
      reason = reason || 'interview-keyword';
      break;
    }
  }

  // Longer text in interview context is more likely to be a question
  if (t.length > 15) {
    score += 0.15;
  }

  // Cap at 1.0
  score = Math.min(1.0, score);

  // In interview context, lower the threshold — better to over-answer
  const isQuestion = score >= 0.35;

  return { isQuestion, confidence: score, reason: reason || 'heuristic' };
}

module.exports = { detect };
