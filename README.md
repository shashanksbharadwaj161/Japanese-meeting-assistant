# Japanese Meeting Assistant

**Japanese conversation support, with English context and answers shaped around you.**

A Windows desktop app for Japanese/English interview practice and bilingual conversations. It combines live transcription, translation, and AI-assisted answer suggestions in a floating overlay, so you can follow a conversation while keeping useful context close at hand.

The repository is named **Japanese Meeting Assistant**; the application and package use **Japanese Interview Assistant**.

[Quick start](#quick-start) · [First session](#your-first-session) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it does

- **Follow spoken Japanese and English.** View live transcripts through Deepgram, with speaker diarization and Japanese-to-English translation.
- **Get personalized answer suggestions.** Supply your resume, job description, company, and interview context to guide responses.
- **Choose how you read Japanese.** Configure romaji, romaji with hiragana, or Japanese with kanji, along with English subtitles.
- **Match your speaking level.** Set a JLPT level from N5 to N1, response length, politeness, and tone.
- **Bring your own prepared answers.** Save question/answer pairs; matching questions use your script before requesting an AI-generated answer.
- **Refine a response during a session.** Make it shorter or longer, regenerate it, request a follow-up, or ask for a recap.
- **Keep a local session record.** Store transcripts and AI responses in SQLite, with Markdown report and plain-text transcript export functions.
- **Adjust the overlay.** Drag, resize, change opacity, and use window visibility shortcuts. Windows capture-protection support includes a self-test.

> **Current implementation:** Live transcription uses Deepgram. AssemblyAI, Vosk, and a transcription-manager module exist in the source, but the active session handler does not currently connect them as automatic speech-to-text fallbacks. This is not a fully offline application.

## Quick start

### Requirements

- **Windows 11, x64** — the documented target platform; window protection uses Windows-specific APIs.
- **Node.js 22 or newer**, with npm.
- **Git**, if cloning from the command line.
- **Deepgram and Anthropic API keys** for the main transcription and coaching workflow.
- An internet connection for cloud transcription and AI requests.

### Install and launch

Run these commands in PowerShell:

```powershell
git clone https://github.com/shashanksbharadwaj161/Japanese-meeting-assistant.git
cd Japanese-meeting-assistant
npm ci
npm start
```

`npm ci` installs the dependency versions recorded in `package-lock.json`. You can also launch the app with `.\start.bat` after installing dependencies.

For the bundled setup workflow:

```powershell
.\setup.bat
```

The setup script runs `npm install`, attempts to download and extract a Japanese Vosk model, and attempts to build the portable Windows executable. The model download is not required for the current Deepgram transcription path. See [INSTALL.md](INSTALL.md) for additional setup notes; the runtime behavior and shortcuts documented here reflect the current source.

## Your first session

1. **Launch the app** and review the preflight screen.
2. **Open Settings** with `Ctrl+,`.
3. **Add your keys** in **API Keys**: Deepgram for speech recognition and Anthropic for translation and coaching.
4. **Set your profile**: Japanese level, output format, answer length, style, and tone.
5. **Add context**: resume or work history, job description, company, interview type, and points to emphasize or avoid. The file-import code includes PDF, DOCX, and TXT readers; pasting text is also an option.
6. **Check audio** and select the appropriate microphone and output devices. Test with a short Japanese/English exchange before a full session.
7. **Start the session** from preflight. Follow the transcript and use the overlay controls to adjust suggested answers.

The current diarized stream assumes the first speaker is the interviewer and the second is the candidate. Let the other speaker begin when testing this workflow.

## Configuration

### API providers

Keys are entered through Settings rather than an `.env` file.

| Provider | Purpose | Needed for |
| --- | --- | --- |
| Deepgram | Live speech recognition and speaker diarization | Current live transcription path |
| Anthropic | Translation, answer generation, recaps, and reports | Main AI workflow |
| OpenAI | Optional GPT-4o-mini answer fallback | Additional answer-provider fallback |
| AssemblyAI | Alternative transcription implementation in the source | Not connected to the current live-session path |

Cloud requests use your own provider accounts and may incur usage charges. Availability depends on your credentials, account access, and the model identifiers configured in the code.

### Prepared answers

In the script section of Settings, enter question/answer pairs:

```text
Q: Jiko shoukai wo onegai shimasu.
A: Hajimemashite. Watashi wa sofutowea enjinia desu. Web apuri no kaihatsu keiken ga arimasu.

Q: Why do you want to work here?
A: Onsha no seihin to gijutsu ni kyoumi ga arimasu. Kore made no keiken wo ikashite kouken shitai desu.
```

Save the script before starting. The app checks for a matching prepared answer before generating a new one. This is useful for practicing a consistent introduction or rehearsing answers in your own words.

### Answer generation

The answer service implements this fallback order:

```text
Prepared script match
        |
        v
Claude Haiku 4.5
        |
        v
Claude Sonnet 4.6
        |
        v
GPT-4o-mini, when an OpenAI key is configured
        |
        v
Matching cached answer / emergency template
```

Fallbacks improve resilience when a request fails; they do not replace a working transcription provider. Cached answers also require suitable content to have been prepared previously.

## Keyboard shortcuts

| Shortcut | Action | Scope |
| --- | --- | --- |
| `Ctrl+Shift+H` | Hide the overlay, settings, and preflight windows | Global |
| `F1` | Backup emergency hide | Global registration attempted; may conflict with other apps |
| `F2` | Toggle overlay visibility | Global |
| `Ctrl+,` | Open Settings | Global |
| `F3` | Request a follow-up | Overlay focused |
| `F4` | Request a recap | Overlay focused |

Use the overlay buttons for **Shorter**, **Longer**, **Follow-up**, and **Regen**. Right-click the overlay to access opacity presets, Settings, and Recap.

The primary hide shortcut is `Ctrl+Shift+H`. The shortcut selector in Settings does not currently change the hard-coded global registrations.

## Audio and platform limitations

The source includes both microphone capture and system loopback capture. **The active transcription handler currently forwards only the `candidate-audio` stream to Deepgram; `interviewer-audio` is not forwarded.** As a result, remote speech that is available only through system output may not reach transcription, particularly when using headphones.

Check that both voices appear in a short test transcript before relying on the app for a conversation. Speaker labels depend on diarization and the assumed speaking order, so they can be incorrect.

Capture protection uses Electron content protection and Windows display-affinity APIs. Its behavior depends on the operating system and capture method. Run the built-in self-test and verify your actual screen-sharing setup; protection is not a guarantee that the overlay will be excluded from every capture.

## Data and privacy

Configuration and session history are stored locally, while enabled cloud services receive the data needed to process requests:

- **Deepgram** receives audio forwarded to the transcription stream.
- **Anthropic** receives text and configured context used for translation, answers, recaps, or reports.
- **OpenAI** receives answer-generation input when its optional fallback is used.

API keys are stored in **plain-text `config.json`**. That file can also contain resume text, job details, and prepared scripts. Session records and exports may contain conversation content. Treat these files as private. Console logs also include transcript snippets and partial API-key prefixes.

| Data | Running from source | Portable executable |
| --- | --- | --- |
| Configuration | `config.json` under Electron's app user-data directory | `config.json` beside the executable |
| Sessions and answer cache | `sessions/sessions.db` under the user-data directory | `sessions/sessions.db` beside the executable |
| Exported reports and transcripts | `exports/` under the user-data directory | `exports/` beside the executable |

The repository's `.gitignore` excludes dependencies, build output, logs, local configuration, and database files. Review exported documents before adding files to version control.

Use transcription and assistance with participants' consent and within the rules of the meeting or interview. Review generated content before using it.

## Build a portable Windows app

From the project directory:

```powershell
npm run build
```

The build configuration targets a portable Windows x64 executable:

```text
dist/JapaneseInterviewAssistant.exe
```

The current packaging metadata uses **Windows Audio Service** as the product name and `com.windows.audioservice` as the app ID. The executable artifact is named `JapaneseInterviewAssistant.exe`.

When moving a portable installation, copy any configuration or session data you need separately. The executable does not embed your API keys or previous sessions.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| App fails to launch | Check `node -v`, run `npm ci` in the project directory, then launch with `npm start` to see errors. |
| Native module or ABI error | Run `npm run rebuild`, then retry. If compilation is required, install the Windows C++ build tools and Python requested by the dependency installer. |
| No transcription | Verify the Deepgram key, account access, internet connection, and microphone permission. AssemblyAI and Vosk do not automatically take over in the current session path. |
| Your voice appears, but the remote speaker does not | Check the audio-routing limitation above. System output is not currently forwarded independently to the live transcription connection. |
| Speakers appear swapped | Restart the session and let the interviewer speak first. Diarization can still misidentify speakers. |
| Transcript works, but no AI answer appears | Check the Anthropic key and provider access. Automatic answers depend on completed speech and question detection. |
| Imported document fails | Paste the text into Settings, or try a plain-text file. Scanned PDFs may need OCR outside the app. |
| A hide shortcut does not work | Try `Ctrl+Shift+H`; function keys can be intercepted by Windows or another app. Use `F2` to show the overlay again. |
| Overlay appears in a screen share | Run the self-test and verify the exact capture method. Capture exclusion varies by environment. |
| Setup cannot download the Vosk model | Use the `npm ci` / `npm start` path for the current cloud workflow. Downloading a model alone does not enable offline transcription. |

## Development

The application uses Electron with plain JavaScript, HTML, and CSS. The main process handles windows, audio routing, provider calls, and persistence; a preload bridge exposes functions to the renderer.

```text
src/
  main.js                Window lifecycle, IPC, and active session routing
  preload.js             Renderer-to-main bridge
  audio/                 Microphone, loopback, and audio processing
  transcription/         Deepgram, AssemblyAI, Vosk, and provider manager
  ai/                    Claude client, translation, question detection, cache, fallbacks
  storage/               JSON configuration and SQLite session storage
  stealth/               Windows capture protection and self-test
  ui/                    Overlay, settings, preflight, and audio worklet
  utils/                 Document text extraction
  watchdog.js            Process-monitoring helper
assets/                  Application icon
models/                  Local speech-model directory; model weights are not bundled
```

| Command | Purpose |
| --- | --- |
| `npm ci` | Install dependencies from the lockfile |
| `npm start` | Launch Electron from source |
| `npm run rebuild` | Rebuild the selected native modules for Electron |
| `npm run build` | Package the portable Windows x64 app |

There is currently no automated test script in `package.json`. For changes to audio, transcription, or window behavior, verify the complete flow on Windows: launch, settings, preflight, both speakers' audio, answer generation, session storage, and visibility shortcuts.

### Contributing

Issues and pull requests are welcome. For a bug report, include your Windows and Node.js versions, steps to reproduce, expected behavior, and redacted logs. Remove API keys, personal documents, and conversation content before sharing diagnostics.

## License

No license file is currently included in this repository. Contact the repository owner about permission to reuse or redistribute the code.
