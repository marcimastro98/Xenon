'use strict';
// Options sheet of the supporter Lyrics widget: translation (with what it
// costs, said plainly), reading for Japanese/Korean/Chinese, the monthly limit,
// stage mode, and the timing every song starts from. Drawn over the tile's
// body; every value is a hub setting, saved like any other.
(function () {
  const OFFSET_STEP_MS = 100;
  const OFFSET_LIMIT_MS = 3000;
  const CAPS = [50, 200, 500];
  // Where each cloud provider publishes its prices. Ollama runs on the PC.
  const PRICING = {
    gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
    openai: 'https://developers.openai.com/api/docs/pricing',
    anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  };
  const PROVIDER_NAMES = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama', claudecode: 'Claude Code', codex: 'Codex' };
  // Claude Code and Codex run on the user's subscription: no money per song,
  // but the plan's usage limits.
  const PLANS = { claudecode: 'Claude', codex: 'ChatGPT' };
  const MODEL_LABELS = { haiku: 'Haiku', default: '' };

  const tr = (key, fallback) => {
    const v = typeof window.t === 'function' ? window.t(key) : '';
    return v && v !== key ? v : (fallback != null ? fallback : key);
  };
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const settings = () => (typeof hubSettings === 'object' && hubSettings ? hubSettings : {});

  function save(patch) {
    // Also from a widget on the screen, where the settings are read-only (utils.js).
    if (typeof saveTileSetting === 'function') saveTileSetting(patch);
  }

  function toggleRow(label, hint, checked, onChange) {
    const row = el('label', 'lyo-row');
    const box = el('input', 'lyo-check');
    box.type = 'checkbox';
    box.checked = !!checked;
    box.addEventListener('change', () => onChange(box.checked));
    const text = el('span', 'lyo-text');
    text.appendChild(el('span', 'lyo-label', label));
    if (hint) text.appendChild(el('span', 'lyo-hint', hint));
    row.append(box, text);
    return row;
  }

  function offsetLabel(ms) {
    const s = (ms / 1000).toLocaleString((typeof lang === 'string' && lang) || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return (ms > 0 ? '+' : '') + s + ' s';
  }

  function globalOffsetRow() {
    const row = el('div', 'lyo-row is-static');
    const text = el('span', 'lyo-text');
    text.append(el('span', 'lyo-label', tr('lyrics_opt_offset_all', 'Delay for every song')),
      el('span', 'lyo-hint', tr('lyrics_opt_offset_all_hint', 'For a player that always runs late. The −/+ on the tile are for the song playing.')));
    const steps = el('div', 'lyw-offset');
    const val = el('span', 'lyw-offset-val');
    const mk = (label, delta, aria) => {
      const b = el('button', 'lyw-step', label);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', () => {
        const next = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, (Number(settings().lyricsOffsetMs) || 0) + delta));
        save({ lyricsOffsetMs: next });
        paint();
        if (window.LyricsCore) window.LyricsCore.sync();
      });
      return b;
    };
    const minus = mk('−', -OFFSET_STEP_MS, tr('lyrics_offset_later'));
    const plus = mk('+', OFFSET_STEP_MS, tr('lyrics_offset_earlier'));
    function paint() {
      const ms = Number(settings().lyricsOffsetMs) || 0;
      val.textContent = offsetLabel(ms);
      minus.disabled = ms <= -OFFSET_LIMIT_MS;
      plus.disabled = ms >= OFFSET_LIMIT_MS;
    }
    paint();
    steps.append(minus, val, plus);
    row.append(text, steps);
    return row;
  }

  function capRow() {
    const row = el('label', 'lyo-row is-static');
    const text = el('span', 'lyo-text');
    text.append(el('span', 'lyo-label', tr('lyrics_opt_cap', 'Monthly limit')),
      el('span', 'lyo-hint', tr('lyrics_opt_cap_hint', 'New songs translated per month. Past it, translation pauses until next month.')));
    const select = el('select', 'lyo-select');
    CAPS.forEach((n) => {
      const o = el('option', '', String(n));
      o.value = String(n);
      select.appendChild(o);
    });
    select.value = String(settings().lyricsTranslateCap || 200);
    select.addEventListener('change', () => { save({ lyricsTranslateCap: Number(select.value) }); refreshUsage(); });
    row.append(text, select);
    return row;
  }

  // The plain account of what translation does with the user's AI provider.
  function costBlock(provider) {
    const box = el('div', 'lyo-cost');
    // A plan is not paid per token, and Codex's fixed instructions make a song
    // far bigger than "about two thousand": the plan paragraph below says it.
    if (!PLANS[provider]) box.appendChild(el('p', '', tr('lyrics_opt_cost_what', 'Each new song is one request to your Bit provider, with the song\'s lines. A song usually takes about two thousand tokens. Songs already translated are kept and never paid for again.')));
    if (provider === 'ollama') box.appendChild(el('p', '', tr('lyrics_opt_cost_ollama', 'With Ollama it is free and stays on this PC.')));
    else if (provider === 'xenon') {
      box.appendChild(el('p', '', tr('lyrics_opt_cost_xenon', 'With Bit on Sparks, translation runs on Haiku, the smallest model, and is paid in Sparks. When your Sparks run out it stops, and starts again as soon as you have more.')));
      estimateLine = el('p', 'lyo-estimate', '');
      box.appendChild(estimateLine);
    }
    else if (provider === 'gemini') box.appendChild(el('p', '', tr('lyrics_opt_cost_gemini', 'Gemini uses its cheapest model (Flash-Lite). On Google\'s free tier you pay nothing, but Google may use what you send to improve its products.')));
    else if (PLANS[provider]) {
      // Filled once the model is known (refreshUsage), said before the switch is on.
      planLine = el('p', 'lyo-plan', '');
      estimateLine = el('p', 'lyo-estimate', '');
      box.append(planLine, estimateLine);
    }
    if (PRICING[provider]) {
      modelLine = provider === 'gemini' ? null : el('p', '', '');
      estimateLine = el('p', 'lyo-estimate', '');
      if (modelLine) box.appendChild(modelLine);
      box.appendChild(estimateLine);
      const a = el('a', 'lyo-link', tr('lyrics_opt_prices', '{provider} prices').replace('{provider}', PROVIDER_NAMES[provider]));
      a.href = PRICING[provider];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      box.appendChild(a);
    }
    return box;
  }

  let usageLine = null;
  let modelLine = null;
  let estimateLine = null;
  let planLine = null;

  const locale = () => (typeof lang === 'string' && lang) || undefined;

  // "About $0.068 per 100 new songs", and what that
  // figure rests on. No estimate for a model without a known price: then the
  // line stays empty and only the provider's price page is offered.
  function paintPlan(u, provider) {
    const model = u && typeof u.model === 'string' ? (MODEL_LABELS[u.model] ?? u.model) : '';
    planLine.textContent = tr('lyrics_opt_cost_plan')
      .replaceAll('{provider}', PROVIDER_NAMES[provider]).replace('{plan}', PLANS[provider])
      .replace('{model}', model || PROVIDER_NAMES[provider]);
    estimateLine.replaceChildren();
    const priced = u && Number(u.songs) > 0 && Number(u.tokens) > 0;
    if (priced) {
      const avg = Math.round(Number(u.tokens) / Number(u.songs) / 100) * 100;
      estimateLine.textContent = tr('lyrics_opt_plan_avg').replace('{tokens}', avg.toLocaleString(locale()));
    }
  }

  function paintEstimate(u, provider) {
    if (planLine) { paintPlan(u, provider); return; }
    if (modelLine) {
      modelLine.textContent = u && u.model ? tr('lyrics_opt_cost_model').replace('{model}', u.model) : '';
    }
    if (!estimateLine) return;
    const e = u && u.estimate;
    estimateLine.replaceChildren();
    if (!e || !Number.isFinite(e.usd)) return;
    if (provider === 'xenon') { paintSparks(e); return; }
    // Providers bill in US dollars: no conversion that would date faster than the price.
    const cost = new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumSignificantDigits: 2 }).format(e.usd);
    const day = new Date(String(e.checked) + 'T12:00:00');
    const date = Number.isNaN(day.getTime()) ? '' : day.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
    const basis = tr(e.measured ? 'lyrics_opt_estimate_measured' : 'lyrics_opt_estimate_typical')
      .replace('{provider}', PROVIDER_NAMES[provider] || provider).replace('{date}', date);
    estimateLine.append(
      el('strong', '', tr('lyrics_opt_estimate', 'About {cost} per {songs} new songs.')
        .replace('{cost}', cost).replace('{songs}', String(e.songs))),
      document.createTextNode(' ' + basis));
  }

  // Bit on Sparks: the figure in Sparks (the server converts it), measured or typical.
  function paintSparks(e) {
    if (!Number.isFinite(e.sparks)) return;
    estimateLine.append(
      el('strong', '', tr('lyrics_opt_estimate_sparks', 'About {sparks} Sparks per {songs} new songs.')
        .replace('{sparks}', e.sparks.toLocaleString(locale())).replace('{songs}', String(e.songs))),
      document.createTextNode(' ' + tr(e.measured ? 'lyrics_opt_sparks_measured' : 'lyrics_opt_sparks_typical')));
  }

  async function refreshUsage() {
    if (!usageLine || !window.LyricsTranslation) return;
    const line = usageLine;
    const provider = typeof settings().aiProvider === 'string' ? settings().aiProvider : 'gemini';
    const u = await window.LyricsTranslation.usage();
    if (!line.isConnected) return;
    paintEstimate(u, provider);
    if (!u) { line.textContent = ''; return; }
    const songs = tr('lyrics_opt_usage', '{songs} of {cap} songs translated this month')
      .replace('{songs}', String(u.songs)).replace('{cap}', String(u.cap));
    // Ollama reports no tokens: say nothing rather than "0 tokens".
    const tokens = Number(u.tokens) > 0
      ? tr('lyrics_opt_usage_tokens', '{tokens} tokens used')
        .replace('{tokens}', Number(u.tokens).toLocaleString(locale()))
      : '';
    line.textContent = tokens ? songs + '\n' + tokens : songs;
  }

  function open(mount, onClose) {
    close(mount);
    modelLine = null;
    estimateLine = null;
    planLine = null;
    const s = settings();
    const provider = typeof s.aiProvider === 'string' ? s.aiProvider : 'gemini';
    const sheet = el('section', 'lyo-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', tr('lyrics_opt_title', 'Lyrics options'));
    const head = el('div', 'lyo-head');
    head.appendChild(el('h3', 'lyo-title', tr('lyrics_opt_title', 'Lyrics options')));
    const done = el('button', 'lyw-btn is-accent', tr('lyrics_opt_done', 'Done'));
    done.type = 'button';
    done.addEventListener('click', () => { close(mount); if (onClose) onClose(); });
    head.appendChild(done);

    const body = el('div', 'lyo-body');
    body.appendChild(toggleRow(tr('lyrics_opt_translate', 'Translate lines'),
      tr('lyrics_opt_translate_hint', 'Under each line, in the dashboard language. Off until you turn it on.'),
      s.lyricsTranslate === true, (on) => { save({ lyricsTranslate: on }); window.LyricsTranslation.reset(); }));
    body.appendChild(costBlock(provider));
    usageLine = el('p', 'lyo-usage', '');
    body.appendChild(usageLine);
    body.appendChild(capRow());
    body.appendChild(toggleRow(tr('lyrics_opt_reading', 'Reading for Japanese, Korean, Chinese'),
      tr('lyrics_opt_reading_hint', 'The line in Latin letters, in the same request as the translation.'),
      s.lyricsReading !== false, (on) => { save({ lyricsReading: on }); window.LyricsTranslation.reset(); }));
    body.appendChild(toggleRow(tr('lyrics_opt_stage', 'Stage mode'),
      tr('lyrics_opt_stage_hint', 'When music starts, this tile fills the screen. It closes 8 s after the music stops, or with ✕ or Esc.'),
      s.lyricsStage === true, (on) => { save({ lyricsStage: on }); if (!on && window.LyricsStage) window.LyricsStage.sync(); }));
    body.appendChild(globalOffsetRow());

    sheet.append(head, body);
    mount.appendChild(sheet);
    mount.classList.add('has-options');
    void refreshUsage();
    done.focus();
  }

  function close(mount) {
    const sheet = mount.querySelector('.lyo-sheet');
    if (sheet) sheet.remove();
    mount.classList.remove('has-options');
  }

  window.LyricsWidgetOptions = { open, close, isOpen: (mount) => !!mount.querySelector('.lyo-sheet') };
})();
