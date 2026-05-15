'use strict';

/**
 * modules/ui.js — iCUE property reading and CSS-variable appearance application.
 *
 * JS writes ONLY these documented CSS variables:
 *   --icue-text  --icue-accent  --icue-bg
 *   --icue-bg-opacity  --icue-blur  --icue-bg-brightness
 */
(function () {
  const Hub = window.XenonEdgeHub;

  // ── MediaViewer (inlined per media-backgrounds.md) ────────────────────────
  // Initialised once; reference kept in closure.
  let _mediaViewer = null;

  function _getOrCreateMediaViewer () {
    const container = document.getElementById('media-background');
    if (!container) return null;
    if (_mediaViewer) return _mediaViewer;

    if (typeof MediaViewer === 'function') {
      const viewer = new MediaViewer({
        container,
        onMediaError: (err) => console.error('[XEH/ui] MediaViewer error:', err)
      });
      _mediaViewer = {
        clear:     ()       => viewer.clear(),
        loadMedia: (config) => viewer.loadMedia(config)
      };
    } else {
      // Static fallback for browser development (no transform support)
      _mediaViewer = {
        clear: () => {
          container.style.backgroundImage = '';
          container.style.visibility = 'hidden';
        },
        loadMedia: (config) => {
          const p = config && config.path;
          if (!p) { container.style.backgroundImage = ''; return; }
          container.style.backgroundImage = "url('" + p.replace(/'/g, "\\'") + "')";
          container.style.backgroundRepeat   = 'no-repeat';
          container.style.backgroundSize     = 'cover';
          container.style.backgroundPosition = 'center';
          container.style.visibility         = 'visible';
        }
      };
    }
    return _mediaViewer;
  }

  function _normalizeMediaConfig (rawMedia) {
    if (!rawMedia) return null;
    let path = '';
    if (typeof rawMedia === 'string') path = rawMedia;
    else path = rawMedia.pathToAsset || rawMedia.path || rawMedia.value || '';
    if (!path) return null;
    const base = (typeof rawMedia === 'object') ? rawMedia : {};
    return {
      path,
      baseWidth:  Number(base.baseWidth)  || Number(base.baseSizeX) || 0,
      baseHeight: Number(base.baseHeight) || Number(base.baseSizeY) || 0,
      scale:      Number.isFinite(Number(base.scale))     ? Number(base.scale)     : 1,
      positionX:  Number(base.positionX) || 0,
      positionY:  Number(base.positionY) || 0,
      angle:      Number(base.angle)     || 0
    };
  }

  // ── Property reading ──────────────────────────────────────────────────────

  /**
   * Reads all iCUE meta-properties into Hub.state and returns them as an object.
   * Must be called on every onDataUpdated event.
   */
  Hub.readProps = function () {
    const g = Hub.getIcueProp;

    // Sensor IDs
    Hub.state.sensorIds.cpuLoad  = g('cpuLoadSensor')  || '';
    Hub.state.sensorIds.cpuTemp  = g('cpuTempSensor')  || '';
    Hub.state.sensorIds.gpuLoad    = g('gpuLoadSensor')    || '';
    Hub.state.sensorIds.gpuTemp    = g('gpuTempSensor')    || '';
    Hub.state.sensorIds.gpuMemLoad = g('gpuMemLoadSensor') || '';
    Hub.state.sensorIds.ramLoad    = g('ramLoadSensor')    || '';
    Hub.state.sensorIds.diskTemp = g('diskTempSensor') || '';
    Hub.state.sensorIds.netUp    = g('netUploadSensor')   || '';
    Hub.state.sensorIds.netDown  = g('netDownloadSensor') || '';

    // Connection
    const rawUrl = g('serverUrl');
    Hub.state.serverUrl = (typeof rawUrl === 'string' && rawUrl.trim())
      ? rawUrl.trim()
      : 'http://localhost:3030';

    // Behaviour
    const use24h      = g('use24h');
    const showSeconds = g('showSeconds');
    Hub.state.use24h      = use24h      === undefined ? true  : !!use24h;
    Hub.state.showSeconds = showSeconds === undefined ? false : !!showSeconds;
  };

  // ── Appearance application ────────────────────────────────────────────────

  /** Applies all appearance CSS variables from iCUE properties. */
  Hub.applyAppearance = function () {
    const g    = Hub.getIcueProp;
    const root = document.documentElement;

    const tc  = g('textColor');
    const ac  = g('accentColor');
    const bgc = g('backgroundColor');

    root.style.setProperty('--icue-text',   (typeof tc  === 'string' && tc)  ? tc  : '#f0f3f1');
    root.style.setProperty('--icue-accent', (typeof ac  === 'string' && ac)  ? ac  : '#1ed760');
    root.style.setProperty('--icue-bg',     (typeof bgc === 'string' && bgc) ? bgc : '#070808');

    const opacity    = Hub.clampRange(g('transparency'),     0, 100, 100) / 100;
    const blur       = Hub.clampRange(g('glassBlur'),        0, 30,  0);
    const brightness = Hub.clampRange(g('bgBrightness'),     0, 100, 100);

    root.style.setProperty('--icue-bg-opacity',     String(opacity));
    root.style.setProperty('--icue-blur',           blur + 'px');
    root.style.setProperty('--icue-bg-brightness',  brightness + '%');

    // Media background
    const viewer = _getOrCreateMediaViewer();
    if (viewer) {
      const config = _normalizeMediaConfig(g('backgroundMedia'));
      if (config) viewer.loadMedia(config);
      else        viewer.clear();
    }
  };

  // ── Server status badge ───────────────────────────────────────────────────

  Hub.updateServerBadge = function () {
    const badge = document.getElementById('server-badge');
    if (!badge) return;
    badge.classList.toggle('online',  Hub.state.serverOnline);
    badge.classList.toggle('offline', !Hub.state.serverOnline);
    badge.title = Hub.tr(Hub.state.serverOnline ? 'server_online' : 'server_offline');
  };

  // ── System tab switcher ───────────────────────────────────────────────────

  Hub.setSystemTab = function (tab, options) {
    const selectedTab = Hub.normalizeSystemTab ? Hub.normalizeSystemTab(tab) : tab;
    const main = document.getElementById('sys-grid-main');
    const net  = document.getElementById('sys-grid-net');
    if (!main || !net) return;
    main.hidden = (selectedTab !== 'main');
    net.hidden  = (selectedTab !== 'net');
    document.querySelectorAll('.sys-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.systab === selectedTab);
    });
    if (!(options && options.silent) && Hub.persistActiveSystemTab) {
      Hub.persistActiveSystemTab(selectedTab);
    }
  };

  // ── Calendar panel toggle ─────────────────────────────────────────────────

  Hub.showCalendar = function (show, automatic) {
    Hub.state.calendarMode = !!show;
    if (!automatic) {
      Hub.state.calendarAutoShown = false;
      if (Hub.persistActiveMediaView) Hub.persistActiveMediaView(Hub.state.calendarMode ? 'calendar' : 'media');
    }
    const panel = document.getElementById('media-panel');
    if (panel) panel.classList.toggle('calendar-mode', Hub.state.calendarMode);
    if (Hub.state.calendarMode) Hub.renderCalendar();
    Hub.updateCalendarMiniPlayer();
  };

  Hub.updateCalendarMiniPlayer = function () {
    const miniPlayer = document.getElementById('calendar-mini-player');
    if (!miniPlayer) return;
    const m = Hub.state.media;
    const miniTitle = document.getElementById('mini-media-title');
    const miniSub   = document.getElementById('mini-media-sub');
    if (miniTitle) miniTitle.textContent = m.title  || Hub.tr('now_playing');
    if (miniSub)   miniSub.textContent   = m.artist || Hub.tr('active_player');
    // Sync mini play/pause icons
    Hub._syncPlayPauseIcons();
  };

  Hub._syncPlayPauseIcons = function () {
    const playing = Hub.state.media.playbackStatus === 'Playing';
    ['play-icon',      'pause-icon'].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.style.display = (i === 0 ? !playing : playing) ? '' : 'none';
    });
    ['mini-play-icon', 'mini-pause-icon'].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.style.display = (i === 0 ? !playing : playing) ? '' : 'none';
    });
  };

  // ── Disk cycling ──────────────────────────────────────────────────────────

  Hub.cycleDisk = function () {
    const disks = Hub.state.disksData;
    if (!disks.length) return;
    Hub.state.currentDiskIdx = (Hub.state.currentDiskIdx + 1) % disks.length;
    Hub.renderDisk();
  };

  Hub.renderDisk = function () {
    const disks = Hub.state.disksData;
    if (!disks.length) return;
    const disk = disks[Hub.state.currentDiskIdx];
    const label = document.getElementById('disk-label');
    const val   = document.getElementById('disk-value');
    const fill  = document.getElementById('disk-fill');
    const sub   = document.getElementById('disk-sub');
    const det   = document.getElementById('disk-detail');
    const cycleBtn = document.getElementById('disk-cycle-btn');

    if (label) label.textContent = disk.label || 'DISK';
    if (val)   val.textContent   = disk.pct != null ? disk.pct + '%' : '--%';
    if (fill)  fill.style.width  = (disk.pct || 0) + '%';
    if (sub)   sub.textContent   = disk.free ? disk.free + ' free' : '';
    if (det)   det.textContent   = disk.total || '';
    if (cycleBtn) cycleBtn.style.display = disks.length > 1 ? '' : 'none';
  };
}());
