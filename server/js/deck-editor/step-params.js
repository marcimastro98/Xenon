// The fields of one step of a deck key: each thing the step's action asks for gets the control of
// its kind, and what is typed goes straight into the step.
'use strict';

window.DeckEditorStepParams = (wrapper) => {
    const {
      DA, appPickControl, audioDevicePickControl, claudeProjectPickControl, dashboardPageControl,
      discordChannelPickControl, discordSoundPickControl, field, haEntityPickControl,
      hotkeyCaptureControl, input, lightDevicePickControl, lightPartPickControl, obsPickControl,
      obsScenes, obsSources, runningAppPickControl, sbActionPickControl, sbCodeTriggerPickControl, sdkHandlerParams,
      sdkMacroPickControl, signalRgbEffectPickControl, soundPickControl, storeAppPickControl, swatchRow,
      t, vmBusOptions, vmStripOptions, wlChannelPickControl, wlEffectOptions, wlMixOptions,
      wlOutputOptions, wlPickControl,
    } = wrapper;

    // Bespoke params for the AI action: a mode select, plus a prompt textarea that
    // only appears for mode 'prompt' (voice/open need no text). Edits write into
    // step.params so the generic save path picks them up unchanged.
    function aiParams(host, step) {
      host.replaceChildren();
      const modes = ['prompt', 'voice', 'open'];
      if (!modes.includes(step.params.mode)) step.params.mode = 'prompt';
      const fMode = field('deck_param_mode');
      const sel = document.createElement('select'); sel.className = 'deck-ed-input';
      modes.forEach((m) => { const o = document.createElement('option'); o.value = m; o.setAttribute('data-i18n', 'deck_opt_' + m); o.textContent = t('deck_opt_' + m); sel.appendChild(o); });
      sel.value = step.params.mode;
      fMode.appendChild(sel); host.appendChild(fMode);

      const fPrompt = field('deck_param_prompt');
      const ta = document.createElement('textarea'); ta.className = 'deck-ed-input'; ta.rows = 2;
      ta.value = step.params.prompt || '';
      ta.placeholder = t('deck_ph_prompt');
      const writePrompt = () => { step.params.prompt = ta.value; };
      ta.addEventListener('input', writePrompt); ta.addEventListener('change', writePrompt);
      fPrompt.appendChild(ta); host.appendChild(fPrompt);

      const syncPrompt = () => { fPrompt.style.display = sel.value === 'prompt' ? '' : 'none'; };
      sel.addEventListener('change', () => { step.params.mode = sel.value; syncPrompt(); });
      syncPrompt();
    }

    // Build the param inputs for one step, writing edits straight into step.params.
    function stepParams(host, step) {
      host.replaceChildren();
      const spec = DA.actionSpec(step.type);
      if (!spec) return;
      if (step.type === 'ai') { aiParams(host, step); return; }
      if (step.type === 'sdkHandler') { sdkHandlerParams(host, step); return; }   // handler + declared-params form
      spec.params.forEach((p) => {
        // Two actions can share a param NAME and still need different labels:
        // claudeAsk's `prompt` is a request to Claude, the ai action's is a
        // prompt. Renaming the param would orphan every stored key, so the spec
        // may override the derived label key instead.
        // Set by another param's control (lightPart's picker fills `device`).
        if (p.kind === 'hidden') return;
        const f = field(p.labelKey || ('deck_param_' + p.name));
        if (step.type === 'hotkey' && p.name === 'keys') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(hotkeyCaptureControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'audioApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(appPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'runningApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(runningAppPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'storeApp') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(storeAppPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'audioDevice') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(audioDevicePickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'obsScene' || p.kind === 'obsSource') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          const fetcher = p.kind === 'obsScene' ? obsScenes : obsSources;
          f.appendChild(obsPickControl(step, p.name, fetcher, 'deck_param_' + p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sbAction') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sbActionPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sbCodeTrigger') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sbCodeTriggerPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'signalRgbEffect') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(signalRgbEffectPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sdkMacro') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(sdkMacroPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'discordChannel') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(discordChannelPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'discordSound') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(discordSoundPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'haEntity') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(haEntityPickControl(step, p.name, p.domain));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'wlMix') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlPickControl(step, p.name, wlMixOptions, t('deck_param_mix')));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'wlEffect') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlPickControl(step, p.name, wlEffectOptions, t('deck_param_effectId')));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'wlOutput') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlPickControl(step, p.name, wlOutputOptions, t('deck_param_deviceId')));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'wlChannel') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlChannelPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'vmStrip') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlPickControl(step, p.name, vmStripOptions, t('deck_param_vm_strip')));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'vmBus') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(wlPickControl(step, p.name, vmBusOptions, t('deck_param_vm_bus')));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'claudeProject') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(claudeProjectPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'dashboardPage') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(dashboardPageControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'lightDevice') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(lightDevicePickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'lightPart') {
          f.appendChild(lightPartPickControl(step));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'sound') {
          if (step.params[p.name] == null) step.params[p.name] = '';
          f.appendChild(soundPickControl(step, p.name));
          host.appendChild(f);
          return;
        }
        if (p.kind === 'color') {
          // The same swatch row as the key's own colours (one tap), with the
          // app's picker behind the last swatch; stored as "#rrggbb" (validated server-side).
          if (!/^#[0-9a-fA-F]{6}$/.test(step.params[p.name] || '')) step.params[p.name] = '#7c5cff';
          f.appendChild(swatchRow(() => step.params[p.name], (v) => { step.params[p.name] = v; }, { allowNone: false }).el);
          host.appendChild(f);
          return;
        }
        let ctrl;
        if (p.kind === 'select') {
          ctrl = document.createElement('select'); ctrl.className = 'deck-ed-input';
          // A param may name its own option words (optionKeys); otherwise the shared deck_opt_*.
          // A kept value the step already holds stays on show when it has words of its own, so opening a key never changes it.
          const shown = [...p.options, ...(p.keeps || []).filter((o) => o === step.params[p.name] && p.optionKeys && p.optionKeys[o])];
          shown.forEach((o) => { const key = (p.optionKeys && p.optionKeys[o]) || ('deck_opt_' + o); const opt = document.createElement('option'); opt.value = o; opt.setAttribute('data-i18n', key); opt.textContent = t(key); ctrl.appendChild(opt); });
          ctrl.value = shown.includes(step.params[p.name]) ? step.params[p.name] : p.options[0];
        } else {
          ctrl = input('text', step.params[p.name] || '');
          // Helpful example placeholders so it's obvious what to enter per param.
          ctrl.placeholder = { path: 'C:\\...\\app.exe', file: 'C:\\...\\suono.mp3', url: 'https://esempio.com', keys: 'ctrl+shift+m', args: '{"key":"value"}', gameId: '1086940', message: t('deck_ph_message'), text: t('deck_ph_text') }[p.name] || '';
        }
        step.params[p.name] = ctrl.value;                 // seed the default
        const write = () => { step.params[p.name] = ctrl.value; };
        ctrl.addEventListener('change', write); ctrl.addEventListener('input', write);
        f.appendChild(ctrl); host.appendChild(f);
      });
    }

    return { stepParams };
};
