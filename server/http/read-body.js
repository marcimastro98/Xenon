// Reads the body of a request, as text or as bytes, and refuses one that grows past its limit.

const { BACKGROUND_MAX_BYTES } = require('./upload-limits.js');

// Default body cap for JSON/text routes. Generous enough for the largest legit
// payload (AI chat carries base64 screenshots, a few MB) while bounding memory
// against a buggy/looping local client that would otherwise grow the string
// without limit. Mirrors the reject pattern of readBodyBuffer; every caller is
// try/catch-wrapped, so the rejection surfaces as a normal 500.
const READ_BODY_MAX_BYTES = 64 * 1024 * 1024;
function readBody(req, maxBytes = READ_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function readBodyBuffer(req, maxBytes = BACKGROUND_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { READ_BODY_MAX_BYTES, readBody, readBodyBuffer };
