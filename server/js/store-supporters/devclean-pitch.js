// What the Developer cleanup tile shows before it is unlocked. The numbers are
// this PC's own (the names-free summary the SDK's devStorage stream also
// carries), so the pitch never shows an invented figure: no data, no number.
(function () {
  'use strict';

  const SOURCES = [
    ['docker', 'devclean_src_docker', 'Docker'],
    ['ollama', 'devclean_src_ollama', 'Modelli Ollama'],
    ['vscode', 'devclean_src_vscode', 'Cartelle degli editor'],
    ['vhdx', 'devclean_src_vhdx', 'Dischi virtuali WSL'],
  ];

  function renderHero(h, preview) {
    const hero = el(h, 'div', 'devclean-pitch-hero');
    hero.appendChild(el(h, 'span', 'devclean-badge', h.tr('devclean_supporters', 'Per i sostenitori')));
    const total = preview && preview.ok ? Number(preview.reclaimable) || 0 : 0;
    if (total > 0) {
      hero.appendChild(el(h, 'p', 'devclean-pitch-num', h.fmtSize(total)));
      hero.appendChild(el(h, 'p', 'devclean-pitch-title', h.tr('devclean_pitch_free', 'che puoi liberare su questo PC')));
    } else {
      hero.appendChild(el(h, 'p', 'devclean-pitch-title is-lead',
        h.tr('devclean_pitch_none', 'Lo spazio che il disco non ti mostra')));
    }
    hero.appendChild(el(h, 'p', 'devclean-pitch-desc', h.tr('devclean_locked_desc',
      'Docker, Ollama, VS Code e WSL accumulano gigabyte che Spazio disco non vede. Questo widget li trova e li libera in sicurezza.')));
    return hero;
  }

  // One bar per source, scaled to the largest, so the eye lands on the big one.
  function renderPreview(h, preview) {
    const box = el(h, 'div', 'devclean-pitch-preview');
    const list = el(h, 'ul', 'devclean-pitch-bars');
    const ready = preview && preview.ok;
    const max = ready
      ? Math.max(1, ...SOURCES.map(([k]) => (preview[k] && preview[k].reclaimable) || 0))
      : 1;
    for (const [key, labelKey, fallback] of SOURCES) {
      const src = ready ? preview[key] : null;
      const off = ready && !(src && src.available);
      const li = el(h, 'li', 'devclean-pitch-row' + (off ? ' is-off' : ''));
      li.appendChild(el(h, 'span', 'devclean-pitch-name', h.tr(labelKey, fallback)));
      li.appendChild(el(h, 'span', 'devclean-pitch-val', !ready ? '…'
        : off ? h.reasonText(src || {}) : h.fmtSize(src.reclaimable || 0)));
      const track = el(h, 'span', 'devclean-pitch-track');
      const fill = el(h, 'span', 'devclean-pitch-fill');
      const pct = ready && !off ? Math.round(((src.reclaimable || 0) / max) * 100) : 0;
      fill.style.setProperty('--fill', pct + '%');
      track.appendChild(fill);
      li.appendChild(track);
      list.appendChild(li);
    }
    box.appendChild(list);
    if (ready) box.appendChild(el(h, 'p', 'devclean-pitch-foot', h.tr('devclean_pitch_real', 'Numeri veri, letti adesso da questo PC.')));
    return box;
  }

  function renderPerks(h) {
    const ul = el(h, 'ul', 'devclean-pitch-perks');
    [
      ['devclean_perk_tools', 'Docker, Ollama, VS Code, Cursor e WSL in un posto solo'],
      ['devclean_perk_safe', 'Prima di ogni passo ti dice cosa succede'],
      ['devclean_perk_forever', 'Sbloccato per sempre su questo PC'],
    ].forEach(([key, fallback]) => {
      const li = el(h, 'li', '');
      li.appendChild(el(h, 'span', 'devclean-pitch-tick', '✓'));
      li.appendChild(el(h, 'span', '', h.tr(key, fallback)));
      ul.appendChild(li);
    });
    return ul;
  }

  function renderCta(h, s) {
    const cta = el(h, 'div', 'devclean-pitch-cta');
    const actions = el(h, 'div', 'devclean-actions');
    if (s.codeSaved) {
      actions.appendChild(h.btn('devclean-btn devclean-btn-accent devclean-btn-big', s.unlocking
        ? h.tr('devclean_unlocking', 'Sblocco…') : h.tr('devclean_unlock', 'Sblocca con il pass'), s.onUnlock, s.unlocking));
    } else {
      const join = el(h, 'a', 'devclean-btn devclean-btn-accent devclean-btn-big devclean-link',
        h.tr('devclean_join', 'Diventa sostenitore'));
      join.href = s.supportUrl;
      join.target = '_blank';
      join.rel = 'noopener noreferrer';
      actions.appendChild(join);
    }
    if (!s.codeFormOpen) {
      actions.appendChild(h.btn('devclean-btn devclean-btn-ghost', s.codeSaved
        ? h.tr('devclean_code_change', 'Usa un altro codice')
        : h.tr('devclean_code_have', 'Ho già un codice'), s.onOpenForm, s.unlocking));
    }
    cta.appendChild(actions);
    if (s.codeFormOpen) cta.appendChild(s.codeForm());
    cta.appendChild(el(h, 'p', 'devclean-pitch-note', s.codeSaved
      ? h.tr('devclean_code_saved', 'Su questo PC c’è già un codice sostenitore: sblocca con un tocco.')
      : h.tr('devclean_code_missing', 'Il codice ti arriva per email subito dopo aver sostenuto Xenon.')));
    if (s.unlockError) cta.appendChild(el(h, 'p', 'devclean-error', s.unlockError));
    return cta;
  }

  function el(h, tag, cls, text) { return h.el(tag, cls, text); }

  /** h = { el, btn, tr, fmtSize, reasonText }; s = locked-state view model. */
  function render(h, s) {
    const box = el(h, 'section', 'devclean-pitch');
    const main = el(h, 'div', 'devclean-pitch-main');
    main.appendChild(renderHero(h, s.preview));
    main.appendChild(renderPerks(h));
    main.appendChild(renderCta(h, s));
    box.appendChild(main);
    box.appendChild(renderPreview(h, s.preview));
    return box;
  }

  window.DevCleanPitch = { render };
})();
