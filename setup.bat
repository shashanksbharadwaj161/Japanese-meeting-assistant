@echo off
echo ===================================
echo JapaneseInterviewAssistant Setup
echo ===================================
echo.
echo Step 1: Installing dependencies...
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed
  echo Make sure Node.js 22 is installed
  pause
  exit /b 1
)
echo.
echo Step 2: Checking Vosk model...
if not exist "models\vosk-model-small-ja\am\final.mdl" (
  echo Downloading Japanese offline model (49MB)...
  echo This is needed for offline fallback only
  powershell -Command "Invoke-WebRequest -Uri 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip' -OutFile 'vosk-model.zip'"
  powershell -Command "Expand-Archive -Path 'vosk-model.zip' -DestinationPath 'models' -Force"
  rename "models\vosk-model-small-ja-0.22" "vosk-model-small-ja"
  del vosk-model.zip
  echo Vosk model installed.
) else (
  echo Vosk model already present.
)
echo.
echo Step 3: Building portable exe...
call npm run build
if errorlevel 1 (
  echo WARNING: Build failed - you can still run with start.bat
)
echo.
echo ===================================
echo Setup complete!
echo Run start.bat to launch the app
echo ===================================
pause
