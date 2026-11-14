'use strict';
// The live chat of the broadcast on air: which chat it is, a page of its messages held for as
// long as YouTube asked, and a message sent to it.

function makeChat({
  getAccessToken, apiRequest, findBroadcast, apiReason, onAir, thumb, PAGE_TOKEN_RE,
  CHAT_ID_MISS_MS, chatMemory,
}) {
  async function chatId() {
    if (onAir.liveCtx.chatId) return onAir.liveCtx.chatId;
    if (chatMemory.chatIdMissAt && Date.now() - chatMemory.chatIdMissAt < CHAT_ID_MISS_MS) return '';
    const b = await findBroadcast();
    onAir.liveCtx = { id: (b && b.id) || '', chatId: (b && b.snippet && b.snippet.liveChatId) || '' };
    chatMemory.chatIdMissAt = onAir.liveCtx.chatId ? 0 : Date.now();
    return onAir.liveCtx.chatId;
  }

  async function chatMessages(pageToken) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const id = await chatId();
    if (!id) return { ok: false, error: 'no_chat' };
    const tok = String(pageToken == null ? '' : pageToken).trim();
    if (tok && !PAGE_TOKEN_RE.test(tok)) return { ok: false, error: 'bad_token' };
    if (chatMemory.chatCache.data && chatMemory.chatCache.token === tok && Date.now() - chatMemory.chatCache.at < chatMemory.chatCache.wait) return chatMemory.chatCache.data;
    let q = '/liveChat/messages?part=snippet,authorDetails&maxResults=50&liveChatId=' + encodeURIComponent(id);
    if (tok) q += '&pageToken=' + encodeURIComponent(tok);
    const r = await apiRequest('GET', q);
    if (!r.ok) {
      // The chat is gone the moment the broadcast ends; forget it so the next
      // status poll can pick up a new one instead of retrying a dead id.
      if (r.status === 403 || r.status === 404) onAir.liveCtx = { id: onAir.liveCtx.id, chatId: '' };
      return { ok: false, error: apiReason(r) };
    }
    const items = (r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    const out = {
      ok: true,
      pageToken: String((r.data && r.data.nextPageToken) || ''),
      pollMs: Math.max(5000, Number(r.data && r.data.pollingIntervalMillis) || 0),
      messages: items.map(m => ({
        id: String((m && m.id) || ''),
        text: String((m.snippet && (m.snippet.displayMessage ||
          (m.snippet.textMessageDetails && m.snippet.textMessageDetails.messageText))) || ''),
        author: String((m.authorDetails && m.authorDetails.displayName) || ''),
        avatar: thumb({ default: { url: (m.authorDetails && m.authorDetails.profileImageUrl) || '' } }),
        owner: !!(m.authorDetails && m.authorDetails.isChatOwner),
        moderator: !!(m.authorDetails && m.authorDetails.isChatModerator),
        sponsor: !!(m.authorDetails && m.authorDetails.isChatSponsor),
      })).filter(m => m.text),
    };
    // Hold the answer for the interval YouTube asked for, keyed on the page that
    // produced it: the next page is a different question and must not be served
    // this one's messages.
    chatMemory.chatCache = { at: Date.now(), token: tok, data: out, wait: out.pollMs };
    return out;
  }

  async function sendChat(text) {
    if (!(await getAccessToken())) return { ok: false, error: 'not_connected' };
    const msg = String(text == null ? '' : text).trim().slice(0, 200);
    if (!msg) return { ok: false, error: 'empty' };
    const id = await chatId();
    if (!id) return { ok: false, error: 'no_chat' };
    const r = await apiRequest('POST', '/liveChat/messages?part=snippet', {
      snippet: { liveChatId: id, type: 'textMessageEvent', textMessageDetails: { messageText: msg } },
    });
    return r.ok ? { ok: true } : { ok: false, error: apiReason(r) };
  }

  return { chatMessages, sendChat };
}

module.exports = { makeChat };
