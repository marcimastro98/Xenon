// Pictures and documents attached to a message: picked, pasted, shown before sending and removed.
'use strict';

// ── Image / screen-capture attachment ────────────────────────────

function aiAttachImage() {
  const inp = $('ai-attach-input');
  if (inp) inp.click();
}

// Text/code files Gemini reads as plain text (sent with mimeType text/plain).
const AI_TEXT_EXT = /\.(txt|md|markdown|log|csv|json|xml|ya?ml|js|ts|jsx|tsx|py|html?|css|ini|sh|c|cpp|h|hpp|java|go|rs|rb|php)$/i;

function aiOnFileAttach(input) {
  const files = Array.from(input.files || []).slice(0, 4);
  input.value = '';
  files.forEach(file => {
    const type = file.type || '';
    const name = file.name || 'file';
    const isImage = type.startsWith('image/');
    const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
    const isText = type.startsWith('text/') || type === 'application/json' || AI_TEXT_EXT.test(name);
    if (!isImage && !isPdf && !isText) {
      setAiStatus(t('ai_attach_unsupported'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = String(e.target.result || '');
      const base64 = dataUrl.split(',')[1];
      if (!base64) return;
      const mimeType = isImage ? type : (isPdf ? 'application/pdf' : 'text/plain');
      _aiPendingImages.push(_aiPreparePicture({ mimeType, data: base64, previewUrl: isImage ? dataUrl : '', name, isImage }));
      _aiUpdateAttachPreview();
    };
    reader.readAsDataURL(file);
  });
}

// Extension badge for a non-image attachment (e.g. "PDF", "TXT").
function _aiDocExt(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return (m ? m[1] : 'doc').toUpperCase().slice(0, 4);
}

// Starts making an attached picture ready to go inside a creation (ai-pictures.js).
function _aiPreparePicture(item) {
  return window.AiPictures ? AiPictures.prepareAiPicture(item) : item;
}

function aiRemoveAttachment(index) {
  _aiPendingImages.splice(index, 1);
  _aiUpdateAttachPreview();
}

function _aiHandlePaste(e) {
  // Only intercept when the chat composer has focus. Since v3.0 the text chat lives
  // in the media tile's Chat tab (initMediaChat() moves the input row out of the
  // overlay), so aiPanelOpen — true only for the voice overlay — is false during
  // normal typing and must not be the gate on its own. Any .ai-text-input counts:
  // the primary one and a duplicated chat's mirror input both feed the same
  // singleton session, and every pane renders the pending-attachment strip.
  const ae = document.activeElement;
  const onChatInput = !!(ae && ae.classList && ae.classList.contains('ai-text-input'));
  if (!aiPanelOpen && !onChatInput) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let addedImage = false;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      if (base64) {
        _aiPendingImages.push(_aiPreparePicture({ mimeType: file.type || 'image/png', data: base64, previewUrl: dataUrl }));
        _aiUpdateAttachPreview();
        // Focus the text input so the user can type a comment
        const inp = $('ai-text-input');
        if (inp && document.activeElement !== inp) inp.focus();
      }
    };
    reader.readAsDataURL(file);
    addedImage = true;
  }
  if (addedImage) e.preventDefault(); // prevent pasting as text
}

// Render the pending-attachment strip into EVERY chat instance: the primary one
// (#ai-attach-preview, moved into the Chat tile by initMediaChat) plus the mirror
// strip media.js injects into each duplicated chat pane. _aiPendingImages is a
// singleton, so each strip is a full render of the same list — not a DOM clone —
// which keeps every remove button wired to the live array.
function _aiUpdateAttachPreview() {
  document.querySelectorAll('.ai-attach-preview').forEach(_aiRenderAttachPreview);
  if (window.BitComposer) BitComposer.sync(); // an attachment alone is sendable
}

function _aiRenderAttachPreview(el) {
  if (!el) return;
  if (_aiPendingImages.length === 0) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  _aiPendingImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'ai-attach-thumb-wrap';
    if (img.isImage === false) {
      const doc = document.createElement('div');
      doc.className = 'ai-attach-doc';
      doc.title = img.name || 'file';
      const ic = document.createElement('span');
      ic.className = 'ai-attach-doc-ext';
      ic.textContent = _aiDocExt(img.name);
      const nm = document.createElement('span');
      nm.className = 'ai-attach-doc-name';
      nm.textContent = img.name || 'file';
      doc.appendChild(ic);
      doc.appendChild(nm);
      wrap.appendChild(doc);
    } else {
      const im = document.createElement('img');
      im.className = 'ai-attach-thumb';
      im.src = img.previewUrl;
      im.alt = 'allegato';
      wrap.appendChild(im);
    }
    const rm = document.createElement('button');
    rm.className = 'ai-attach-thumb-rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.onclick = () => aiRemoveAttachment(i);
    wrap.appendChild(rm);
    el.appendChild(wrap);
  });
}

window.aiAttachImage       = aiAttachImage;
window.aiOnFileAttach      = aiOnFileAttach;

window.aiRemoveAttachment  = aiRemoveAttachment;
