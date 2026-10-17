// =============================================================================
// Stealth Self-Test — Verifies WDA_EXCLUDEFROMCAPTURE is working
// =============================================================================
// Takes a screenshot of the screen region where the overlay sits using
// Win32 BitBlt, then checks if the overlay's pixels are visible.
// If the overlay IS visible in the capture, it automatically applies
// the koffi-based protection and re-tests.
// =============================================================================

'use strict';

let koffi;
let user32;
let gdi32;
let koffiLoaded = false;

// Win32 function references
let GetDC, ReleaseDC;
let CreateCompatibleDC, CreateCompatibleBitmap, SelectObject;
let BitBlt, GetPixel, DeleteDC, DeleteObject;

const SRCCOPY = 0x00CC0020;

/**
 * Lazy-load koffi and bind all required GDI/User32 functions.
 */
function ensureKoffi() {
  if (koffiLoaded) return true;
  try {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    gdi32 = koffi.load('gdi32.dll');

    // User32
    GetDC = user32.func('GetDC', 'void *', ['void *']);
    ReleaseDC = user32.func('ReleaseDC', 'int', ['void *', 'void *']);

    // GDI32
    CreateCompatibleDC = gdi32.func('CreateCompatibleDC', 'void *', ['void *']);
    CreateCompatibleBitmap = gdi32.func('CreateCompatibleBitmap', 'void *', ['void *', 'int', 'int']);
    SelectObject = gdi32.func('SelectObject', 'void *', ['void *', 'void *']);
    BitBlt = gdi32.func('BitBlt', 'bool', [
      'void *', 'int', 'int', 'int', 'int',
      'void *', 'int', 'int', 'uint32'
    ]);
    GetPixel = gdi32.func('GetPixel', 'uint32', ['void *', 'int', 'int']);
    DeleteDC = gdi32.func('DeleteDC', 'bool', ['void *']);
    DeleteObject = gdi32.func('DeleteObject', 'bool', ['void *']);

    koffiLoaded = true;
    return true;
  } catch (err) {
    console.error('[selftest] Failed to load koffi/GDI:', err.message);
    return false;
  }
}

/**
 * Capture a screen region and sample pixels to detect overlay visibility.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds
 * @returns {{ visiblePixels: number, totalSamples: number, ratio: number }}
 */
function captureAndSample(bounds) {
  const nullPtr = null; // null HWND = entire screen

  const screenDC = GetDC(nullPtr);
  if (!screenDC) throw new Error('GetDC(null) returned null');

  const memDC = CreateCompatibleDC(screenDC);
  if (!memDC) {
    ReleaseDC(nullPtr, screenDC);
    throw new Error('CreateCompatibleDC returned null');
  }

  const bitmap = CreateCompatibleBitmap(screenDC, bounds.width, bounds.height);
  if (!bitmap) {
    DeleteDC(memDC);
    ReleaseDC(nullPtr, screenDC);
    throw new Error('CreateCompatibleBitmap returned null');
  }

  SelectObject(memDC, bitmap);

  // Copy screen region to memory DC
  const blitOk = BitBlt(
    memDC, 0, 0, bounds.width, bounds.height,
    screenDC, bounds.x, bounds.y,
    SRCCOPY
  );

  if (!blitOk) {
    DeleteObject(bitmap);
    DeleteDC(memDC);
    ReleaseDC(nullPtr, screenDC);
    throw new Error('BitBlt failed');
  }

  // Sample pixels in a grid across the captured region
  // If the window is protected, the captured area should be all black (0x000000)
  // because WDA_EXCLUDEFROMCAPTURE replaces the window content with black in captures
  const GRID = 15; // 15x15 = 225 sample points
  const stepX = Math.max(1, Math.floor(bounds.width / (GRID + 1)));
  const stepY = Math.max(1, Math.floor(bounds.height / (GRID + 1)));
  let nonBlackPixels = 0;
  const totalSamples = GRID * GRID;

  for (let i = 1; i <= GRID; i++) {
    for (let j = 1; j <= GRID; j++) {
      const px = stepX * i;
      const py = stepY * j;
      if (px >= bounds.width || py >= bounds.height) continue;

      const color = GetPixel(memDC, px, py);
      // CLR_INVALID = 0xFFFFFFFF means error; treat as non-black
      // Black = 0x00000000 (protected window content)
      if (color !== 0x00000000 && color !== 0xFFFFFFFF) {
        nonBlackPixels++;
      }
    }
  }

  // Cleanup GDI resources
  DeleteObject(bitmap);
  DeleteDC(memDC);
  ReleaseDC(nullPtr, screenDC);

  const ratio = nonBlackPixels / totalSamples;
  return { visiblePixels: nonBlackPixels, totalSamples, ratio };
}

/**
 * Run the stealth self-test on the overlay window.
 *
 * @param {BrowserWindow} browserWindow - The overlay BrowserWindow
 * @returns {Promise<{ safe: boolean, method: string, message: string }>}
 */
async function runSelfTest(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return { safe: false, method: 'none', message: 'Window not available for testing' };
  }

  if (!ensureKoffi()) {
    return {
      safe: false,
      method: 'none',
      message: 'Cannot run self-test: koffi/GDI not available. Screen capture protection cannot be verified.'
    };
  }

  const bounds = browserWindow.getBounds();

  // Ensure the window is visible for the test
  if (!browserWindow.isVisible()) {
    browserWindow.show();
    // Brief delay for the window to render
    await new Promise(r => setTimeout(r, 300));
  }

  try {
    // --- First test: check current state ---
    const firstResult = captureAndSample(bounds);

    // If <20% of pixels are non-black, the window is protected
    if (firstResult.ratio < 0.2) {
      const method = browserWindow.isContentProtected && browserWindow.isContentProtected()
        ? 'electron'
        : 'koffi';
      return {
        safe: true,
        method,
        message: `Window is properly hidden from screen capture (${Math.round((1 - firstResult.ratio) * 100)}% black pixels).`
      };
    }

    // --- Window IS visible — try to fix with koffi ---
    console.warn(`[selftest] Window visible in capture: ${Math.round(firstResult.ratio * 100)}% non-black pixels. Applying koffi fix...`);

    const { applyProtection } = require('./protection');
    const protResult = applyProtection(browserWindow);

    if (!protResult.success) {
      return {
        safe: false,
        method: 'failed',
        message: `Window is VISIBLE in screen capture and protection could not be applied. ${Math.round(firstResult.ratio * 100)}% of sampled pixels were non-black.`
      };
    }

    // Brief delay for protection to take effect
    await new Promise(r => setTimeout(r, 500));

    // --- Re-test after applying koffi fix ---
    const secondResult = captureAndSample(bounds);

    if (secondResult.ratio < 0.2) {
      return {
        safe: true,
        method: 'koffi-fallback',
        message: `Protection was missing but koffi fix succeeded. Window is now hidden (${Math.round((1 - secondResult.ratio) * 100)}% black pixels after fix).`
      };
    }

    // Still visible even after koffi fix
    return {
      safe: false,
      method: 'failed',
      message: `WARNING: Window is still VISIBLE after applying all protection methods. ${Math.round(secondResult.ratio * 100)}% of pixels non-black. Your Windows version may not support WDA_EXCLUDEFROMCAPTURE. Consider using a virtual camera or different display setup.`
    };
  } catch (err) {
    return {
      safe: false,
      method: 'error',
      message: `Self-test error: ${err.message}`
    };
  }
}

module.exports = { runSelfTest };
