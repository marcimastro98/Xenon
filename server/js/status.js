'use strict';

// The connection dot of the dashboard header. A page without it (the light
// layer page, which carries tiles that report here) has nothing to mark.
function setOnline() {
  if (!statusDot) return;
  statusDot.classList.remove('offline');
  statusDot.title = t('online');
}

function setOffline() {
  if (!statusDot) return;
  statusDot.classList.add('offline');
  statusDot.title = t('offline');
}
