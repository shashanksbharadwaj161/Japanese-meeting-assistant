// =============================================================================
// Watchdog — Heartbeat monitor for the main Electron app
// =============================================================================
// Runs as a separate plain Node.js child_process (not Electron).
// Receives heartbeat messages from the main app every 2 seconds.
// If no heartbeat for 6 seconds, restarts the main app.
// Max 5 restarts before giving up.
// =============================================================================

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- State ---
let lastHeartbeat = Date.now();
let isShuttingDown = false;
let restartCount = 0;
const MAX_RESTARTS = 5;
const HEARTBEAT_TIMEOUT = 6000; // 6 seconds
const CHECK_INTERVAL = 2000;    // check every 2 seconds

// --- Log file ---
const logDir = process.env.PORTABLE_EXECUTABLE_DIR || path.join(__dirname, '..');
const logPath = path.join(logDir, 'watchdog.log');

function log(message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {
    // Silently fail — can't write to disk
  }
}

// --- Heartbeat check ---
function checkHeartbeat() {
  if (isShuttingDown) return;

  const elapsed = Date.now() - lastHeartbeat;
  if (elapsed > HEARTBEAT_TIMEOUT) {
    log(`No heartbeat for ${elapsed}ms — attempting restart (${restartCount + 1}/${MAX_RESTARTS})`);
    restartApp();
  }
}

// --- Restart the main app ---
function restartApp() {
  if (restartCount >= MAX_RESTARTS) {
    log(`Max restarts reached (${MAX_RESTARTS}). Giving up.`);
    clearInterval(heartbeatTimer);
    process.exit(1);
    return;
  }

  restartCount++;

  // The main app was started via Electron. We need to re-launch the same way.
  // process.env._ or process.execPath from the parent gives us the electron binary.
  // For portable exe, the executable itself is the entry point.
  const electronExe = process.env.ELECTRON_EXE_PATH || process.execPath;
  const appRoot = process.env.APP_ROOT || path.join(__dirname, '..');

  log(`Restart #${restartCount}: spawning ${electronExe} ${appRoot}`);

  try {
    const child = spawn(electronExe, [appRoot], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();
    log(`Restart spawned (PID: ${child.pid})`);
  } catch (err) {
    log(`Restart failed: ${err.message}`);
  }

  // Reset heartbeat timer — give the new process time to start
  lastHeartbeat = Date.now();
}

// --- IPC from parent process ---
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'heartbeat') {
    lastHeartbeat = Date.now();
  } else if (msg.type === 'shutdown') {
    isShuttingDown = true;
    log('Clean shutdown requested by parent');
    clearInterval(heartbeatTimer);
    process.exit(0);
  }
});

// --- Parent disconnect (crash, kill, etc.) ---
process.on('disconnect', () => {
  if (isShuttingDown) return;

  log('Parent disconnected unexpectedly — waiting 3s then restarting');
  setTimeout(() => {
    if (!isShuttingDown) {
      restartApp();
    }
    clearInterval(heartbeatTimer);
    // Exit after restart attempt — the new process will spawn its own watchdog
    setTimeout(() => process.exit(0), 1000);
  }, 3000);
});

// --- Signal handlers ---
process.on('SIGTERM', () => {
  isShuttingDown = true;
  clearInterval(heartbeatTimer);
  log('SIGTERM received — exiting');
  process.exit(0);
});

process.on('SIGINT', () => {
  isShuttingDown = true;
  clearInterval(heartbeatTimer);
  log('SIGINT received — exiting');
  process.exit(0);
});

// --- Start ---
const heartbeatTimer = setInterval(checkHeartbeat, CHECK_INTERVAL);

log(`Watchdog started (PID: ${process.pid}, parent PID: ${process.ppid || 'unknown'})`);

// Notify parent we're ready
if (process.send) {
  process.send({ type: 'watchdog-ready' });
}
