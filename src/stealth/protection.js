// =============================================================================
// Stealth Protection — Multi-method screen-capture exclusion
// =============================================================================
// Methods tried in order:
//   1. Electron setContentProtection(true)
//   2. koffi SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) — requires
//      correct HWND read as pointer-sized integer on x64
//   3. koffi SetWindowDisplayAffinity(WDA_MONITOR) — older compat flag
//   4. koffi SetLayeredWindowAttributes — visual layering fallback
//   5. Give up but warn user
// =============================================================================

'use strict';

let koffi;
let user32;
let SetWindowDisplayAffinity;
let SetWindowLongPtrW;
let GetWindowLongPtrW;
let SetLayeredWindowAttributes;
let koffiLoaded = false;

const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;            // Older: shows black on capture
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;  // Win10 2004+: invisible to capture

const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const LWA_ALPHA = 0x00000002;

function ensureKoffi() {
  if (koffiLoaded) return true;
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    SetWindowDisplayAffinity = user32.func(
      'SetWindowDisplayAffinity', 'bool', ['void *', 'uint32']
    );
    // For layered window fallback
    SetWindowLongPtrW = user32.func(
      'SetWindowLongPtrW', 'long', ['void *', 'int', 'long']
    );
    GetWindowLongPtrW = user32.func(
      'GetWindowLongPtrW', 'long', ['void *', 'int']
    );
    SetLayeredWindowAttributes = user32.func(
      'SetLayeredWindowAttributes', 'bool', ['void *', 'uint32', 'uint8', 'uint32']
    );
    koffiLoaded = true;
    return true;
  } catch (err) {
    console.error('[stealth] Failed to load koffi/user32.dll:', err.message);
    return false;
  }
}

/**
 * Extract the native HWND from an Electron BrowserWindow.
 * On Windows x64, HWND is an 8-byte pointer. koffi accepts the raw Buffer
 * directly as a 'pointer' argument.
 */
function getHwnd(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    throw new Error('Cannot get HWND: window is null or destroyed');
  }
  const buf = browserWindow.getNativeWindowHandle();
  if (!buf || buf.length === 0) {
    throw new Error('getNativeWindowHandle returned empty buffer');
  }
  // Log the raw bytes for debugging
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log('[stealth] HWND buffer (' + buf.length + ' bytes):', hex);
  return buf;
}

/**
 * Apply screen-capture protection. Tries methods in order of strength.
 * Returns { success, method } describing what worked.
 */
function applyProtection(browserWindow) {
  const results = [];

  // --- Method 1: Electron built-in ---
  try {
    browserWindow.setContentProtection(true);
    results.push({ method: 'electron', ok: true });
    console.log('[stealth] Method 1: Electron setContentProtection(true) applied');
  } catch (err) {
    results.push({ method: 'electron', ok: false, err: err.message });
    console.warn('[stealth] Method 1 failed:', err.message);
  }

  if (!ensureKoffi()) {
    const best = results.find(r => r.ok);
    return { success: !!best, method: best ? best.method : 'failed' };
  }

  let hwnd;
  try {
    hwnd = getHwnd(browserWindow);
  } catch (err) {
    console.error('[stealth] Cannot get HWND:', err.message);
    const best = results.find(r => r.ok);
    return { success: !!best, method: best ? best.method : 'failed' };
  }

  // --- Method 2: WDA_EXCLUDEFROMCAPTURE (strongest, Win10 2004+) ---
  try {
    const ok = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    results.push({ method: 'koffi-exclude', ok });
    if (ok) {
      console.log('[stealth] Method 2: WDA_EXCLUDEFROMCAPTURE applied (strongest)');
      return { success: true, method: 'koffi-exclude' };
    }
    // WDA fails on transparent/layered Electron windows — try removing transparency first
    console.warn('[stealth] Method 2: returned false (transparent windows often block WDA)');
  } catch (err) {
    results.push({ method: 'koffi-exclude', ok: false, err: err.message });
    console.warn('[stealth] Method 2 exception:', err.message);
  }

  // --- Method 3: WDA_MONITOR (older compat, shows black in capture) ---
  try {
    const ok = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
    results.push({ method: 'koffi-monitor', ok });
    if (ok) {
      console.log('[stealth] Method 3: WDA_MONITOR applied (capture shows black)');
      return { success: true, method: 'koffi-monitor' };
    }
    console.warn('[stealth] Method 3: WDA_MONITOR also returned false');
  } catch (err) {
    results.push({ method: 'koffi-monitor', ok: false, err: err.message });
    console.warn('[stealth] Method 3 exception:', err.message);
  }

  // --- Method 4: Layered window + tool-window style ---
  // Some capture tools skip WS_EX_TOOLWINDOW windows
  try {
    const exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    const newStyle = exStyle | WS_EX_TOOLWINDOW;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, newStyle);
    results.push({ method: 'toolwindow', ok: true });
    console.log('[stealth] Method 4: WS_EX_TOOLWINDOW applied (hides from some capture tools)');
    return { success: true, method: 'toolwindow' };
  } catch (err) {
    results.push({ method: 'toolwindow', ok: false, err: err.message });
    console.warn('[stealth] Method 4 exception:', err.message);
  }

  // --- Fallback: Electron protection was applied above ---
  const best = results.find(r => r.ok);
  if (best) {
    console.log('[stealth] Best protection available:', best.method);
    return { success: true, method: best.method };
  }

  console.error('[stealth] ALL protection methods failed:', JSON.stringify(results));
  return { success: false, method: 'failed' };
}

/**
 * Remove screen-capture protection.
 */
function removeProtection(browserWindow) {
  try { browserWindow.setContentProtection(false); } catch {}

  if (ensureKoffi()) {
    try {
      const hwnd = getHwnd(browserWindow);
      SetWindowDisplayAffinity(hwnd, WDA_NONE);
    } catch {}
  }
  return { success: true };
}

/**
 * Re-apply protection after a window show(). Windows can lose WDA after
 * hide/show cycles.
 */
function reapplyAfterShow(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  try { browserWindow.setContentProtection(true); } catch {}
  if (ensureKoffi()) {
    try {
      const hwnd = getHwnd(browserWindow);
      SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    } catch {}
  }
}

module.exports = {
  applyProtection,
  removeProtection,
  reapplyAfterShow,
  getHwnd,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE
};
