// The doorbell and camera choices of the home (settings.home), shown in both the Home Assistant
// and the UniFi Protect settings: the card when someone rings, its push to the paired phone,
// whether Bit may send a camera picture to the AI to say who is there, and the home log on this PC.
'use strict';

(() => {
  const t = (k, fb) => {
    const out = typeof window.t === 'function' ? window.t(k) : '';
    return out && out !== k ? out : fb;
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const current = () => (typeof hubSettings === 'object' && hubSettings && hubSettings.home) || { doorbell: true, doorbellPush: true, bitCameras: 'ask', log: true };

  function save(patch) {
    if (typeof hubSettings !== 'object' || !hubSettings) return;
    hubSettings = normalizeSettings({ ...hubSettings, home: { ...current(), ...patch } });
    saveHubSettings();
  }

  function toggle(text, hint, checked, onChange) {
    const row = el('label', 'settings-toggle-row');
    const cb = el('input', 'settings-check');
    cb.type = 'checkbox';
    cb.checked = checked;
    const line = el('span', 'settings-label-line');
    line.append(el('span', '', text), el('span', 'settings-hint', hint));
    row.append(cb, line);
    cb.addEventListener('change', () => onChange(cb.checked));
    return row;
  }

  function lookChoice(value) {
    const row = el('div', 'sh-set-row');
    row.appendChild(el('span', 'sh-set-label', t('home_cam_look', 'Bit looks at camera pictures')));
    const seg = el('div', 'settings-segmented');
    const options = [['ask', 'home_cam_ask', 'Ask me first'], ['yes', 'home_cam_yes', 'Yes'], ['no', 'home_cam_no', 'No']];
    for (const [v, key, fb] of options) {
      const b = el('button', 'settings-segment-btn' + (v === (value === 'local' ? 'ask' : value) ? ' active' : ''), t(key, fb));
      b.type = 'button';
      b.addEventListener('click', () => {
        for (const x of seg.querySelectorAll('.settings-segment-btn')) x.classList.toggle('active', x === b);
        save({ bitCameras: v });
      });
      seg.appendChild(b);
    }
    row.appendChild(seg);
    return row;
  }

  function build() {
    const home = current();
    const wrap = el('section', 'settings-section home-section');
    wrap.appendChild(el('div', 'settings-section-title', t('door_kicker', 'Doorbell')));
    const push = toggle(t('home_door_push', 'Tell the paired phone too'), t('home_door_push_hint', 'A notification on the phone paired with Xenon.'),
      home.doorbellPush, (on) => save({ doorbellPush: on }));
    push.hidden = !home.doorbell;
    wrap.append(
      toggle(t('home_door_card', 'Show who rings at the door'), t('home_door_card_hint', 'A card with the door camera on every Xenon screen, while Xenon is open.'),
        home.doorbell, (on) => { push.hidden = !on; save({ doorbell: on }); }),
      push,
      lookChoice(home.bitCameras),
      el('div', 'settings-hint', t('home_cam_look_hint', 'To say who is there, Bit sends the picture to the AI you use. Without a yes it only shows you the picture.')),
      toggle(t('home_log', 'Remember what happens at home'), t('home_log_hint', 'Rings, what the cameras pick out and doors or windows opened in the last two days, on this PC only, so you can ask Bit. Never pictures.'),
        home.log !== false, (on) => save({ log: on })),
    );
    return wrap;
  }

  // Under Home Assistant and under the cameras, where either is connected: the same three choices.
  function mount() {
    const ha = (typeof hubSettings === 'object' && hubSettings && hubSettings.homeAssistant) || {};
    const unifi = (typeof hubSettings === 'object' && hubSettings && hubSettings.unifi) || {};
    const places = [['settings-smarthome-hub', ha.url && ha.tokenSet], ['settings-unifi-hub', unifi.host && unifi.passwordSet]];
    for (const [id, connected] of places) {
      const host = document.getElementById(id);
      if (!host) continue;
      const old = host.querySelector(':scope > .home-section');
      if (old) old.remove();
      if (connected) host.appendChild(build());
    }
  }

  window.HomeSection = { build, mount };
})();
