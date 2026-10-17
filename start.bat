@echo off
if not exist "node_modules" (
  echo Please run setup.bat first
  pause
  exit /b 1
)
npm start
