// ============================================================================
// File Parser — Extract text from PDF, DOCX, and TXT files
// ============================================================================

const fs = require('fs');
const path = require('path');

async function parsePDF(filePath) {
  const { PDFParse } = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const parser = new PDFParse(uint8);
  await parser.load();
  const text = await parser.getText();
  parser.destroy();
  return cleanText(text);
}

/**
 * Parse a Word .docx file and extract its text content.
 * mammoth.extractRawText accepts {path} or {buffer}.
 */
async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  // Use path-based API — more reliable than buffer for .docx
  const result = await mammoth.extractRawText({ path: filePath });
  return cleanText(result.value);
}

/**
 * Parse a plain text file.
 */
async function parseTxt(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return cleanText(text);
}

/**
 * Auto-detect file type and parse accordingly.
 * Supports: .pdf, .docx, .doc, .txt
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  try {
    let text;
    let fileType;

    switch (ext) {
      case '.pdf':
        text = await parsePDF(filePath);
        fileType = 'pdf';
        break;
      case '.docx':
      case '.doc':
        text = await parseDocx(filePath);
        fileType = 'docx';
        break;
      case '.txt':
        text = await parseTxt(filePath);
        fileType = 'txt';
        break;
      default:
        text = await parseTxt(filePath);
        fileType = 'text';
        break;
    }

    if (!text || text.trim().length === 0) {
      throw new Error('File appears empty or could not extract any text.');
    }

    return { text, fileName, fileType };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('password') || msg.includes('encrypted') || msg.includes('Password')) {
      throw new Error(`File "${fileName}" is password-protected. Remove the password and try again.`);
    }
    if (msg.includes('corrupt') || msg.includes('invalid') || msg.includes('Could not find')) {
      throw new Error(`File "${fileName}" appears corrupted or is not a valid ${ext} file.`);
    }
    if (msg.includes('ENOENT')) {
      throw new Error(`File not found: "${fileName}"`);
    }
    throw new Error(`Failed to parse "${fileName}": ${msg}`);
  }
}

/**
 * Strip excessive whitespace and formatting artifacts from extracted text.
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/ {3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\s+|\s+$/g, '')
    .trim();
}

module.exports = { parseFile, parsePDF, parseDocx, parseTxt, cleanText };
