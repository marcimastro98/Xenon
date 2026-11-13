'use strict';

let preferredMediaSource = normalizeMediaSource(localStorage.getItem(MEDIA_SOURCE_STORAGE_KEY));

function renderMediaSourcePicker(data) {
  const picker = $('media-source-picker');
  const select = $('media-source-select');
  if (!picker || !select) return;

  const sessions = Array.isArray(data && data.sessions) ? data.sessions.filter(isActiveMediaSession) : [];
  const uniqueSessions = [];
  const seenSources = new Set();
  sessions.forEach(session => {
    const source = normalizeMediaSource(session && session.source);
    if (!source || seenSources.has(source)) return;
    seenSources.add(source);
    uniqueSessions.push({ ...session, source });
  });

  picker.hidden = uniqueSessions.length < 2;
  if (picker.hidden) {
    if (preferredMediaSource && !seenSources.has(preferredMediaSource)) {
      preferredMediaSource = '';
      localStorage.removeItem(MEDIA_SOURCE_STORAGE_KEY);
      // The dashboard clears the server's choice; a layer window would only repeat it.
      if (!(typeof isLayerPage === 'function' && isLayerPage())) postPreferredMediaSource('');
    }
    return;
  }

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('media_source_auto');
  const options = [auto, ...uniqueSessions.map(session => {
    const option = document.createElement('option');
    option.value = session.source;
    option.textContent = mediaSessionLabel(session);
    return option;
  })];

  select.replaceChildren(...options);
  select.value = seenSources.has(preferredMediaSource) ? preferredMediaSource : '';
  syncMediaSourceSelectLabel(select);
}

function setPreferredMediaSource(source) {
  const next = normalizeMediaSource(source);
  if (next === preferredMediaSource) return;
  preferredMediaSource = next;
  if (preferredMediaSource) localStorage.setItem(MEDIA_SOURCE_STORAGE_KEY, preferredMediaSource);
  else localStorage.removeItem(MEDIA_SOURCE_STORAGE_KEY);
  postPreferredMediaSource(preferredMediaSource);
  fetchMedia();
}
