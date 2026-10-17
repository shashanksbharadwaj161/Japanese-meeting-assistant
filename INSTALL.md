# Installation Guide

## Prerequisites

You need these installed on your Windows 11 computer:

1. **Node.js 22 LTS** - Download from https://nodejs.org (choose the LTS version)
   - During installation, check "Automatically install necessary tools"
   - After installation, open a new Command Prompt and type `node -v` to verify

2. **Git** (optional) - Download from https://git-scm.com if you want to clone the repo

## Setup

1. Open Command Prompt or PowerShell
2. Navigate to the JapaneseInterviewAssistant folder:
   ```
   cd path\to\JapaneseInterviewAssistant
   ```
3. Run the setup script:
   ```
   setup.bat
   ```
   This installs all dependencies automatically.

## First Run

1. Double-click `start.bat` or run `npm start` from the terminal
2. The app will open with a preflight check screen
3. Press **Ctrl+,** to open Settings

## Adding API Keys

You need at least these two API keys:

### Deepgram (Speech-to-Text)
1. Go to https://console.deepgram.com/signup
2. Sign up for a free account (you get $200 free credit)
3. Create a new API key
4. Paste it in Settings > API Keys > Deepgram

### Anthropic (AI Coaching)
1. Go to https://console.anthropic.com
2. Sign up and add billing
3. Create a new API key
4. Paste it in Settings > API Keys > Anthropic

### AssemblyAI (Optional Fallback)
1. Go to https://www.assemblyai.com/dashboard/signup
2. Sign up for a free account
3. Copy your API key from the dashboard
4. Paste it in Settings > API Keys > AssemblyAI

## Running Your First Interview

1. Start the app with `start.bat`
2. Wait for all preflight checks to pass
3. Click "Start Session"
4. Open your video call (Zoom, Teams, Google Meet)
5. The overlay appears at the top of your screen
6. The app listens to your interviewer and shows coached answers

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| F1 | Emergency hide (hides everything instantly) |
| F2 | Toggle overlay visibility |
| Ctrl+, | Open settings |

## Troubleshooting

**App window visible in screen share:**
Run the self-test from Settings. If it fails, your Windows version may not support the hiding feature. Try updating Windows 11 to the latest version.

**No audio being captured:**
Make sure the correct audio device is selected in Settings > Audio. The system audio device should match what your video call uses for output.

**Transcription not working:**
Check that your Deepgram API key is correct and you have remaining credit at https://console.deepgram.com

**App won't start:**
Make sure Node.js 22+ is installed. Run `node -v` in Command Prompt to check.

## Building a Portable EXE

To create a single portable executable:
```
npm run build
```
The output will be in the `dist` folder. Copy it to a USB drive along with your config.json.
