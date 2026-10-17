// ============================================================================
// Config Storage — JSON config beside the .exe (portable) or userData
// ============================================================================
//
// Functions:
//   loadConfig()                  — Load config, deep-merge with defaults
//   saveConfig(config)            — Save full config
//   getConfigPath()               — Get config file path
//   getApiKeys()                  — Get just the API keys section
//   updateApiKey(service, key)    — Update a single API key
//   resetToDefaults()             — Reset config to defaults
//   validateConfig()              — Validate config structure + API key formats
//
// Storage: config.json beside the .exe (PORTABLE_EXECUTABLE_DIR) or userData
// ============================================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  profile: {
    name: '',
    level: 'N3',
    style: 'polite',
    format: 'romaji',
    length: 'medium',
    tone: 'humble'
  },
  context: {
    resume: '',
    resumeFileName: '',
    jobDescription: '',
    jobDescFileName: '',
    company: '',
    interviewType: 'HR',
    emphasize: '',
    avoid: ''
  },
  scripts: {
    pairs: [],
    rawText: '',
    lastUpdated: ''
  },
  audio: {
    systemDevice: 'default',
    micDevice: 'default',
    language: 'auto',
    autoAnswer: true,
    sensitivity: 1.5,
    noiseSuppression: true
  },
  display: {
    position: 'top-center',
    opacity: 75,
    fontSize: 'large',
    theme: 'dark',
    showENQuestion: true,
    showENSubs: true,
    width: 'medium'
  },
  apiKeys: {
    deepgram: '',
    anthropic: '',
    assemblyai: '',
    openai: ''
  },
  stealth: {
    hideTaskbar: true,
    hideAltTab: true,
    screenProtection: true,
    processName: 'Windows Audio Service',
    selfTest: true,
    emergencyKey: 'Ctrl+Shift+H'
  },
  panel: {
    x: null,
    y: null,
    width: 500,
    height: 400,
    opacity: 75,
    fontSize: 'large',
    snapPosition: 'top-center',
    miniMode: false
  }
};

// -----------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------

function getConfigPath() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    return path.join(portableDir, 'config.json');
  }
  return path.join(app.getPath('userData'), 'config.json');
}

// -----------------------------------------------------------------------
// Load / Save
// -----------------------------------------------------------------------

function loadConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const saved = JSON.parse(raw);
      return deepMerge(structuredClone(DEFAULT_CONFIG), saved);
    }
  } catch (err) {
    console.error('Failed to load config:', err.message);
  }
  return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(config) {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// -----------------------------------------------------------------------
// API key helpers
// -----------------------------------------------------------------------

/**
 * Get just the API keys section from config.
 * @returns {object} { deepgram, anthropic, assemblyai, openai }
 */
function getApiKeys() {
  const config = loadConfig();
  return { ...config.apiKeys };
}

/**
 * Update a single API key without touching the rest of the config.
 * @param {string} service - 'deepgram' | 'anthropic' | 'assemblyai' | 'openai'
 * @param {string} key     - The API key value
 */
function updateApiKey(service, key) {
  const validServices = ['deepgram', 'anthropic', 'assemblyai', 'openai'];
  if (!validServices.includes(service)) {
    throw new Error(`Invalid service: ${service}. Valid: ${validServices.join(', ')}`);
  }

  const config = loadConfig();
  config.apiKeys[service] = key || '';
  saveConfig(config);
}

// -----------------------------------------------------------------------
// Reset
// -----------------------------------------------------------------------

/**
 * Reset config to defaults. Preserves API keys by default.
 * @param {boolean} includeKeys - If true, also wipes API keys
 */
function resetToDefaults(includeKeys = false) {
  const config = loadConfig();
  const savedKeys = { ...config.apiKeys };

  const fresh = structuredClone(DEFAULT_CONFIG);

  if (!includeKeys) {
    fresh.apiKeys = savedKeys;
  }

  saveConfig(fresh);
  return fresh;
}

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------

/**
 * Validate config structure and API key formats.
 * Returns an array of warning strings (empty = all good).
 *
 * @param {object} config - Config object to validate (default: loaded config)
 * @returns {object} { valid: boolean, warnings: string[], errors: string[] }
 */
function validateConfig(config) {
  if (!config) config = loadConfig();

  const warnings = [];
  const errors = [];

  // Profile validation
  if (!config.profile) {
    errors.push('Missing profile section');
  } else {
    const validLevels = ['N1', 'N2', 'N3', 'N4', 'N5'];
    if (config.profile.level && !validLevels.includes(config.profile.level)) {
      warnings.push(`Invalid JLPT level: ${config.profile.level}. Valid: ${validLevels.join(', ')}`);
    }

    const validStyles = ['polite', 'casual', 'formal', 'humble'];
    if (config.profile.style && !validStyles.includes(config.profile.style)) {
      warnings.push(`Invalid style: ${config.profile.style}. Valid: ${validStyles.join(', ')}`);
    }

    const validLengths = ['short', 'medium', 'detailed'];
    if (config.profile.length && !validLengths.includes(config.profile.length)) {
      warnings.push(`Invalid length: ${config.profile.length}. Valid: ${validLengths.join(', ')}`);
    }

    const validFormats = ['romaji', 'hiragana', 'mixed'];
    if (config.profile.format && !validFormats.includes(config.profile.format)) {
      warnings.push(`Invalid format: ${config.profile.format}. Valid: ${validFormats.join(', ')}`);
    }
  }

  // API key format validation (basic checks, not full verification)
  if (config.apiKeys) {
    if (config.apiKeys.deepgram && !config.apiKeys.deepgram.match(/^[a-f0-9]{30,}$/i)) {
      warnings.push('Deepgram API key format looks unusual (expected hex string, 30+ chars)');
    }

    if (config.apiKeys.anthropic && !config.apiKeys.anthropic.startsWith('sk-ant-')) {
      warnings.push('Anthropic API key should start with "sk-ant-"');
    }

    if (config.apiKeys.openai && !config.apiKeys.openai.startsWith('sk-')) {
      warnings.push('OpenAI API key should start with "sk-"');
    }

    // Check for at least one STT key
    if (!config.apiKeys.deepgram && !config.apiKeys.assemblyai) {
      warnings.push('No STT API key configured. Only offline Vosk will be available (degraded quality).');
    }

    // Check for Claude key
    if (!config.apiKeys.anthropic) {
      warnings.push('No Anthropic API key. Translation, coaching, and reports will be unavailable.');
    }
  } else {
    errors.push('Missing apiKeys section');
  }

  // Audio validation
  if (config.audio) {
    const validLanguages = ['auto', 'multi', 'ja', 'en', 'ja-JP', 'en-US'];
    if (config.audio.language && !validLanguages.includes(config.audio.language)) {
      warnings.push(`Unusual language setting: ${config.audio.language}`);
    }
  }

  // Display validation
  if (config.display) {
    if (config.display.opacity != null && (config.display.opacity < 10 || config.display.opacity > 100)) {
      warnings.push(`Display opacity ${config.display.opacity} is outside recommended range (10-100)`);
    }
  }

  // Panel validation
  if (config.panel) {
    if (config.panel.opacity != null && (config.panel.opacity < 10 || config.panel.opacity > 100)) {
      warnings.push(`Panel opacity ${config.panel.opacity} is outside recommended range (10-100)`);
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors
  };
}

// -----------------------------------------------------------------------
// Deep merge helper
// -----------------------------------------------------------------------

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

module.exports = {
  loadConfig,
  saveConfig,
  getConfigPath,
  getApiKeys,
  updateApiKey,
  resetToDefaults,
  validateConfig,
  DEFAULT_CONFIG
};
