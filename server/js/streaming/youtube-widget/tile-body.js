// The YouTube tile as it is first built: the watermark, the notice that leads to Streaming
// settings, and the two cards.
'use strict';

window.YoutubeWidgetTileBody = (wrapper) => {
  const { buildPlayerCard, buildLibraryCard } = wrapper;

  const { ICONS, t, el, openStreamingSettings } = window.YoutubeWidgetLook;

  function ensure(mount) {
    // Bumped when the built markup changes: a hidden widget's DOM is kept in the
    // pool rather than destroyed, so a stale build would never gain the notice.
    if (mount.dataset.ytBuilt === '4' && mount.firstChild) return;
    mount.dataset.ytBuilt = '4';
    const wrap = el('div', 'yt-wrap');
    wrap.dataset.view = 'normal';

    const wm = el('div', 'yt-watermark'); wm.innerHTML = ICONS.logo;   // static, trusted SVG
    wrap.appendChild(wm);

    const notice = el('button', 'yt-setup'); notice.type = 'button'; notice.hidden = true;
    notice.append(el('span', 'yt-setup-txt', t('youtube_w_setup', 'Connect your YouTube account in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    const cards = el('div', 'yt-cards');
    cards.append(buildPlayerCard(), buildLibraryCard());
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  return { ensure };
};
