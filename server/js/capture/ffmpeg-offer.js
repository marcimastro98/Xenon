'use strict';
// Settings → Performance: the FFmpeg card. From 5.1.0 the setup no longer adds
// FFmpeg, and voice chat, local voices, MP4 backgrounds and screenshots need it.
// Like the sensors card next to it, the section exists only when there is
// something to do: Windows, FFmpeg not found. The server downloads a pinned
// build (server/ffmpeg-install/); this page asks for it and shows how far it is.
(function () {
  const el = makeEl;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function install(btn, say) {
    btn.disabled = true;
    say('', t('ffmpeg_install_busy', 'Downloading FFmpeg…'));
    let done = false;
    const answer = apiJson('/api/ffmpeg/install', { method: 'POST' }).finally(() => { done = true; });
    while (!done) {
      await sleep(1000);
      const s = await apiJson('/api/ffmpeg/status');
      if (!done && s && s.installing && typeof s.percent === 'number') {
        say('', t('ffmpeg_install_progress', 'Downloading FFmpeg… {percent}%').replace('{percent}', String(s.percent)));
      }
    }
    const res = await answer;
    if (res && res.ok) { say('is-ok', t('ffmpeg_install_done', 'FFmpeg is installed. Voice and video features work now.')); return; }
    say('is-warn', t('ffmpeg_install_failed', 'FFmpeg could not be installed. Check the internet connection and try again.'));
    btn.disabled = false;
  }

  async function initSettings() {
    const host = document.getElementById('settings-ffmpeg-hub');
    if (!host) return;
    const s = await apiJson('/api/ffmpeg/status');
    if (!s || !s.supported || s.installed) { host.replaceChildren(); return; }

    const group = el('div', 'settings-group');
    const head = el('div', 'settings-group-head');
    head.appendChild(el('span', '', 'FFmpeg'));
    group.appendChild(head);
    const wrap = group.appendChild(el('div', 'sa-hint sa-hint--settings'));
    wrap.appendChild(el('div', 'sa-hint-text', t('ffmpeg_missing_desc', 'Voice chat, local voices, MP4 backgrounds and screenshots need FFmpeg, a free audio and video tool. About 115 MB, one click.')));
    const btn = el('button', 'settings-btn primary');
    btn.type = 'button';
    btn.textContent = t('ffmpeg_install_btn', 'Install FFmpeg');
    const status = el('div', 'sa-status');
    const say = (cls, text) => { status.className = 'sa-status' + (cls ? ' ' + cls : ''); status.textContent = text; };
    btn.addEventListener('click', () => { if (!btn.disabled) install(btn, say); });
    wrap.append(btn, status);
    host.replaceChildren(group);
    if (s.installing) install(btn, say);
  }

  window.FfmpegOffer = { initSettings };
})();
