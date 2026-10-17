// ============================================================================
// Translator — 50+ pre-cached phrases, Claude fallback with 3s timeout
// ============================================================================
// Priority: local cache (0ms) → Claude Haiku (max 3s) → return null
// No streaming. No system prompt. Minimal tokens.
// ============================================================================

'use strict';

const CACHE = new Map([
  ['こんにちは', 'Hello'],
  ['よろしくお願いします', 'Nice to meet you / Thank you in advance'],
  ['お疲れ様です', 'Thank you for your hard work'],
  ['ありがとうございました', 'Thank you very much'],
  ['はい', 'Yes'],
  ['いいえ', 'No'],
  ['そうですね', "That's right / Let me think..."],
  ['失礼します', 'Excuse me'],
  ['お願いします', 'Please'],
  ['分かりました', 'I understand'],
  ['すみません', 'Excuse me / I\'m sorry'],
  ['自己紹介をお願いします', 'Please introduce yourself'],
  ['自己紹介してください', 'Please introduce yourself'],
  ['自己紹介', 'Self-introduction'],
  ['あなたの強みは何ですか', 'What are your strengths?'],
  ['強みは何ですか', 'What are your strengths?'],
  ['あなたの弱みは何ですか', 'What are your weaknesses?'],
  ['弱みは何ですか', 'What are your weaknesses?'],
  ['なぜこの会社を選びましたか', 'Why did you choose this company?'],
  ['志望動機を教えてください', 'Please tell us your motivation for applying'],
  ['志望動機', 'Motivation for applying'],
  ['キャリア目標は何ですか', 'What are your career goals?'],
  ['キャリア目標', 'Career goals'],
  ['五年後の自分はどうなっていたいですか', 'Where do you see yourself in 5 years?'],
  ['何か質問はありますか', 'Do you have any questions?'],
  ['前職について教えてください', 'Please tell us about your previous job'],
  ['チームワークの経験を教えてください', 'Tell us about your teamwork experience'],
  ['ストレス管理はどうしていますか', 'How do you manage stress?'],
  ['リーダーシップの経験はありますか', 'Do you have leadership experience?'],
  ['なぜ転職したいのですか', 'Why do you want to change jobs?'],
  ['いつから働けますか', 'When can you start?'],
  ['他に受けている会社はありますか', 'Are you interviewing at other companies?'],
  ['希望年収はいくらですか', 'What is your desired salary?'],
  ['残業についてどう思いますか', 'How do you feel about overtime?'],
  ['リモートワークについてどう思いますか', 'How do you feel about remote work?'],
  ['最後に何か伝えたいことはありますか', 'Is there anything else you\'d like to tell us?'],
  ['得意なことは何ですか', 'What are you good at?'],
  ['失敗した経験を教えてください', 'Tell us about a time you failed'],
  ['難しい問題に直面した時どうしますか', 'What do you do when facing a difficult problem?'],
  ['プレッシャーの中でどう対応しますか', 'How do you handle pressure?'],
  ['チームで働くのと一人で働くのとどちらが好きですか', 'Do you prefer working in a team or alone?'],
  ['この仕事のどこに魅力を感じますか', 'What attracts you to this job?'],
  ['今までの仕事の経験を教えてください', 'Tell us about your work experience'],
  ['一番印象に残ったプロジェクトは何ですか', 'What project left the biggest impression?'],
  ['上司との関係をどう築きますか', 'How do you build relationships with superiors?'],
  ['意見が合わない時はどうしますか', 'What do you do when opinions differ?'],
  ['簡単に自己紹介をしてください', 'Please give a brief self-introduction'],
  ['これまでの経歴を教えてください', 'Please tell us about your career history'],
  ['どういう方ですか', 'What kind of person are you?'],
  ['改善したいところはありますか', 'Are there areas you want to improve?'],
]);

// Runtime cache for Claude-translated phrases
const runtimeCache = new Map();
const RUNTIME_MAX = 200;

let _apiKey = '';
let _model = 'claude-haiku-4-5';

function configure(apiKey, model) {
  _apiKey = apiKey || '';
  _model = model || 'claude-haiku-4-5';
}

/**
 * Translate Japanese text to English.
 * Returns { translation, source: 'cache'|'api'|null, ms }
 * If translation fails within 3s, returns { translation: null }
 */
async function translate(jpText) {
  if (!jpText || !jpText.trim()) return { translation: null, source: null, ms: 0 };
  const key = jpText.trim();
  const t0 = Date.now();

  // 1. Check pre-built cache
  if (CACHE.has(key)) {
    return { translation: CACHE.get(key), source: 'cache', ms: 0 };
  }

  // 2. Check runtime cache
  if (runtimeCache.has(key)) {
    return { translation: runtimeCache.get(key), source: 'cache', ms: 0 };
  }

  // 3. Partial match — check if text contains a cached phrase
  for (const [jp, en] of CACHE) {
    if (key.includes(jp) && jp.length > 3) {
      return { translation: en, source: 'cache', ms: 0 };
    }
  }

  // 4. Claude API with 3s timeout
  if (!_apiKey) return { translation: null, source: null, ms: Date.now() - t0 };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': _apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: _model,
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: `Translate this Japanese to English. Reply with ONLY the translation. `
                 + `No markdown, no explanation, no breakdown, no asterisks, no headers. `
                 + `Just the plain English translation in one sentence.\n\n${key}`
        }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!resp.ok) return { translation: null, source: null, ms: Date.now() - t0 };

    const data = await resp.json();
    let translation = (data.content && data.content[0] && data.content[0].text || '');

    // Strip any markdown the model may still emit, keep the first line only.
    translation = translation
      .replace(/^#+\s*/gm, '')   // headers
      .replace(/\*\*/g, '')      // bold
      .replace(/---+/g, '')      // horizontal rules
      .trim()
      .split('\n')[0]            // first line only
      .trim();

    if (translation) {
      // Store in runtime cache
      runtimeCache.set(key, translation);
      if (runtimeCache.size > RUNTIME_MAX) {
        const oldest = runtimeCache.keys().next().value;
        runtimeCache.delete(oldest);
      }
    }

    return { translation: translation || null, source: 'api', ms: Date.now() - t0 };
  } catch {
    // Timeout or network error — return null, show JP only
    return { translation: null, source: null, ms: Date.now() - t0 };
  }
}

/**
 * Stream a Japanese→English translation token-by-token.
 * Calls onToken(text) for each delta as Claude streams the translation.
 * Returns the full translation string (also cached for reuse).
 */
async function streamTranslate(jpText, onToken) {
  if (!jpText || !jpText.trim() || !_apiKey) return '';
  const key = jpText.trim();

  // Instant cache hits — emit the whole thing at once, no API call.
  if (CACHE.has(key)) { const en = CACHE.get(key); if (onToken) onToken(en); return en; }
  if (runtimeCache.has(key)) { const en = runtimeCache.get(key); if (onToken) onToken(en); return en; }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': _apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 50,
      stream: true,
      system: 'Translate to English. One line only. No markdown, no explanation.',
      messages: [{ role: 'user', content: jpText }]
    })
  });

  if (!response.ok || !response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
            full += data.delta.text;
            if (onToken) onToken(data.delta.text);
          }
        } catch { /* keepalive / non-JSON line */ }
      }
    }
  }

  if (full) {
    runtimeCache.set(key, full);
    if (runtimeCache.size > RUNTIME_MAX) {
      const oldest = runtimeCache.keys().next().value;
      runtimeCache.delete(oldest);
    }
  }
  return full;
}

function clearCache() {
  runtimeCache.clear();
}

module.exports = { translate, streamTranslate, configure, clearCache, CACHE };
