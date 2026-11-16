// What the YouTube player shows over the picture when the embed refuses a video: the sentence that
// fits the error, and the key that opens the video in the browser.
'use strict';

window.YoutubeWidgetBlockedOverlay = (wrapper) => {
  const { player, cur, watchUrl, openOut } = wrapper;

  const { t, el } = window.YoutubeWidgetLook;

  // "This video cannot be played inside apps" is the right sentence for a video
  // the owner locked, and the wrong one for error 153, where every video fails
  // and none of them is at fault. Saying it anyway sent a macOS user hunting
  // through his library for one that would work (#126).
  function blockedText() {
    if (player.errCode === 153) {
      return t('youtube_embed_config', 'YouTube would not start the player here. This is not the video: open it in the browser.');
    }
    return t('youtube_no_embed', 'This video cannot be played inside apps.');
  }

  function buildBlockedOverlay() {
    const blocked = el('div', 'yt-blocked');
    blocked.append(el('span', 'yt-blocked-txt', blockedText()));
    const bb = el('button', 'yt-blocked-btn', t('youtube_open_browser', 'Open in the browser'));
    bb.type = 'button';
    bb.addEventListener('click', async () => { const v = cur(); const url = v && watchUrl(v.id); if (url) await openOut(url); });
    blocked.appendChild(bb);
    return blocked;
  }

  return { blockedText, buildBlockedOverlay };
};
