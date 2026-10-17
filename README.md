# Japanese Interview Assistant

Real-time Japanese/English bilingual interview assistant for Windows.

## Stack

- **Runtime:** Electron 41.7.1
- **STT:** Deepgram Nova-3 Multilingual (primary), AssemblyAI (fallback), Vosk (offline)
- **AI:** Claude Haiku 4.5 with prompt caching
- **Stealth:** WDA_EXCLUDEFROMCAPTURE via koffi + user32.dll
- **Packaging:** electron-builder portable x64

## Quick Start

```
setup.bat    # Install dependencies
start.bat    # Launch the app
```

See [INSTALL.md](INSTALL.md) for detailed instructions.

## Project Structure

```
src/
  main.js              # Electron main process
  preload.js           # Secure context bridge
  audio/               # System audio + mic capture
  transcription/       # STT providers (Deepgram, AssemblyAI, Vosk)
  ai/                  # Claude API + fallback + cache
  stealth/             # Window protection + self-test
  ui/                  # Overlay, settings, preflight HTML
  storage/             # Config + session database
  watchdog.js          # Process monitor
models/                # Vosk offline models
assets/                # App icon
```

## Key Shortcuts

| Key | Action |
|-----|--------|
| F1 | Emergency hide |
| F2 | Toggle overlay |
| Ctrl+, | Settings |
