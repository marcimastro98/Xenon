// The tile around a widget: its head with the two keys, and the message it shows while there is no
// frame to show.
'use strict';

window.CustomWidgetTileBody = (wrapper) => {
  const { ICONS, el } = wrapper;

  const { t } = window.CustomWidgetHostSays;

  // ── Tile rendering ───────────────────────────────────────────────
  function ensure(mount) {
    if (mount.dataset.cwBuilt === '1' && mount.firstChild) return;
    mount.dataset.cwBuilt = '1';
    const wrap = el('div', 'cw-wrap');
    const head = el('div', 'cw-head');
    const brand = el('div', 'cw-brand');
    const logo = el('span', 'cw-logo'); logo.innerHTML = ICONS.puzzle;   // static, trusted SVG
    brand.append(logo, el('span', 'cw-title', t('cw_title', 'Custom widget')));
    head.appendChild(brand);
    const ctl = el('div', 'cw-ctl');
    const reloadBtn = el('button', 'cw-hbtn cw-reload-btn');
    reloadBtn.type = 'button'; reloadBtn.title = t('cw_reload', 'Reload widget (pick up file changes)');
    reloadBtn.innerHTML = ICONS.reload;   // static, trusted SVG
    ctl.appendChild(reloadBtn);
    const swapBtn = el('button', 'cw-hbtn cw-swap-btn');
    swapBtn.type = 'button'; swapBtn.title = t('cw_unassign', 'Choose another widget');
    swapBtn.innerHTML = ICONS.swap;   // static, trusted SVG
    ctl.appendChild(swapBtn);
    head.appendChild(ctl);
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'cw-body'));
    mount.replaceChildren(wrap);
  }

  function showState(body, msgKey, msgFb, opts) {
    const box = el('div', 'cw-state');
    const ico = el('span', 'cw-state-ico'); ico.innerHTML = ICONS.puzzle;   // static SVG
    // `message`: a pre-built literal (a translated line with a name in it).
    box.append(ico, el('span', 'cw-state-txt', (opts && opts.message) || t(msgKey, msgFb)));
    if (opts && opts.hint) box.appendChild(el('span', 'cw-state-hint', t(opts.hint[0], opts.hint[1])));
    if (opts && opts.buttons) {
      const row = el('div', 'cw-state-btns');
      opts.buttons.forEach(b => {
        // `label` is a pre-built literal (a translated verb + an untranslatable
        // proper name); everything else resolves through the i18n key.
        const btn = el('button', 'cw-btn' + (b.primary ? ' cw-btn--primary' : ''), b.label || t(b.key, b.fb));
        btn.type = 'button';
        btn.addEventListener('click', b.onClick);
        row.appendChild(btn);
      });
      box.appendChild(row);
    }
    body.replaceChildren(box);
  }

  // A tile of a widget its creator keeps to the top bar (manifest `tile: false`): it runs there by
  // itself, so this box only says so and offers to hold another widget. An on-screen widget has no
  // chooser (its editor changes it), so it gets no button.
  function showBarOnly(body, chooseOther) {
    showState(body, 'cw_bar_only', 'This widget lives in the top bar', {
      hint: ['cw_bar_only_hint', 'Its creator made it for the bar, where it runs by itself. You can remove this box.'],
      ...(chooseOther ? { buttons: [{ key: 'cw_unassign', fb: 'Choose another', primary: true, onClick: chooseOther }] } : {}),
    });
  }

  return { ensure, showState, showBarOnly };
};
