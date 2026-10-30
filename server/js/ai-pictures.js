'use strict';
// Pictures attached to the chat, made ready to go INSIDE what Xenon AI creates:
// the server swaps the "attached:N" the model writes for them
// (ai-attached-pictures.js). The model still sees each attachment as it was
// sent; this is a second, smaller copy that fits every slot taking an image.
// A moving picture stays moving (anim-picture.js); a still one is made smaller
// as WebP until it fits. Needs AnimPicture and rasterToCanvas (utils.js).

const AI_PICTURE_MAX_CHARS = 400000;   // the server's PICTURE_MAX_CHARS
const AI_PICTURE_EDGES = [1600, 1200, 900, 640];
const AI_PICTURE_KEEP = /^data:image\/(png|jpeg|webp|gif);base64,/;

function _aiPictureBlob(item) {
  const bin = atob(item.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: item.mimeType });
}

// One attachment ({mimeType, data: base64}) → a data URL that fits, or null.
async function fitAiPicture(item) {
  if (!item || !/^image\//.test(item.mimeType || '') || !item.data) return null;
  let blob;
  try { blob = _aiPictureBlob(item); } catch { return null; }
  const moving = typeof AnimPicture !== 'undefined'
    ? await AnimPicture.fitAnimatedPicture(blob, { maxChars: AI_PICTURE_MAX_CHARS, maxSide: AI_PICTURE_EDGES[0] }).catch(() => null)
    : null;
  if (moving && moving.dataUrl) return moving.dataUrl;
  if (moving && moving.refused === 'broken') return null;
  const asSent = `data:${item.mimeType};base64,${item.data}`;
  if (!moving && AI_PICTURE_KEEP.test(asSent) && asSent.length <= AI_PICTURE_MAX_CHARS) return asSent;
  // Too big, or a moving picture that could not stay moving: a smaller still.
  for (const edge of AI_PICTURE_EDGES) {
    const cv = typeof rasterToCanvas === 'function' ? await rasterToCanvas(blob, edge) : null;
    if (!cv) return null;
    const url = cv.toDataURL('image/webp', 0.85);
    if (AI_PICTURE_KEEP.test(url) && url.length <= AI_PICTURE_MAX_CHARS) return url;
  }
  return null;
}

// Starts fitting an attachment as soon as it is added, so sending waits less.
function prepareAiPicture(item) {
  if (item && !item.picture && /^image\//.test(item.mimeType || '')) item.picture = fitAiPicture(item).catch(() => null);
  return item;
}

// The attachments of one message → the `pictures` the server numbers as
// attached:1, attached:2…: one per picture, in the order the model sees them
// (documents are left out), null where a picture could not be made to fit and
// for the screen capture that screen mode adds by itself: context, not content.
async function aiPicturesForSend(parts) {
  const pictures = (parts || []).filter((p) => p && /^image\//.test(p.mimeType || ''));
  return Promise.all(pictures.map((p) => (p.fromScreenMode ? null : prepareAiPicture(p).picture)));
}

const AiPictures = { AI_PICTURE_MAX_CHARS, fitAiPicture, prepareAiPicture, aiPicturesForSend };
if (typeof window !== 'undefined') window.AiPictures = AiPictures;
if (typeof module !== 'undefined' && module.exports) module.exports = AiPictures;
