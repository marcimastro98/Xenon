// What a run can be started with: the models offered (read from what this machine has used), the
// permission modes and the effort levels, and their lists in the composer.
'use strict';

(() => {
  const { t } = window.ClaudeWidgetWords;
  const { shortModel } = window.ClaudeWidgetModelWords;
  const { widgetState } = window.ClaudeWidgetKnown;
  const { composerSelect } = window.ClaudeWidgetComposerParts;

  // The models to offer are read from what this machine has ACTUALLY used —
  // the model ids in your own transcripts, biggest first. A hard-coded list was
  // wrong in both directions: it left out models you use every day and it would
  // keep offering names long after they stop existing. The CLI's short aliases
  // are kept alongside them, because they are the stable way to say "the current
  // Opus" and they survive a version bump that retires a dated id.
  const ASK_ALIASES = ['opus', 'sonnet', 'haiku'];
  const MAX_ASK_MODELS = 14;
  function askModelOptions() {
    // "Auto" on its own said nothing, but the full explanation belongs in the
    // open list, not in the closed trigger — there it just stretched the control
    // across the bar. The trigger keeps the short word; the list says what it
    // falls back to, which differs: continuing a session keeps that session's
    // model, a new run takes the project's own Claude Code config.
    const out = [{
      id: '',
      label: t('claude_model_auto', 'Auto'),
      note: widgetState.askResumeId
        ? t('claude_model_auto_session', 'keeps the session model')
        : t('claude_model_auto_project', 'the project default'),
    }];
    ASK_ALIASES.forEach(a => out.push({
      id: a,
      label: a.charAt(0).toUpperCase() + a.slice(1),
      note: t('claude_model_alias_note', 'always the current one'),
    }));
    const u = widgetState.payload && widgetState.payload.usage;
    const seen = new Set(out.map(o => o.id));
    ((u && u.models) || []).forEach(m => {
      const id = String(m.model || '');
      // `<synthetic>` and friends are placeholders Claude Code writes for turns
      // that never went to a model. Offering one as a choice would guarantee a
      // failed run.
      if (!id || id === 'unknown' || id.charAt(0) === '<' || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label: shortModel(id) });
    });
    // The selected model must always be in the list, or the dropdown would
    // silently fall back to Auto and start a run on something else.
    if (widgetState.askModel && !seen.has(widgetState.askModel)) out.push({ id: widgetState.askModel, label: shortModel(widgetState.askModel) });
    return out.slice(0, MAX_ASK_MODELS);
  }

  // The permission modes a run can start in, as Claude Code's footer names
  // them. '' keeps whatever the user set as their default.
  const RUN_MODE_LABELS = {
    manual: ['claude_run_mode_manual', 'Ask for everything'],
    acceptEdits: ['claude_mode_accept', 'accept edits on'],
    plan: ['claude_mode_plan', 'plan mode on'],
  };
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

  function runModeSelect() {
    const opts = [{ id: '', label: t('claude_run_mode_default', 'Default mode'), note: t('claude_run_mode_default_note', 'your Claude Code setting') }];
    widgetState.askOptions.modes.forEach((m) => opts.push({ id: m, label: t(RUN_MODE_LABELS[m][0], RUN_MODE_LABELS[m][1]) }));
    return composerSelect('cw-ask-mode-sel', t('claude_run_mode', 'Permission mode'), opts, widgetState.askRunMode, (v) => { widgetState.askRunMode = v; });
  }

  function effortSelect() {
    const opts = [{ id: '', label: t('claude_effort', 'effort') + ': ' + t('claude_model_auto', 'Auto') }];
    EFFORTS.forEach((e) => opts.push({ id: e, label: t('claude_effort', 'effort') + ': ' + e }));
    return composerSelect('cw-ask-effort-sel', t('claude_effort', 'effort'), opts, widgetState.askEffort, (v) => { widgetState.askEffort = v; });
  }

  window.ClaudeWidgetRunOptions = {
    askModelOptions, RUN_MODE_LABELS, EFFORTS, runModeSelect, effortSelect,
  };
})();
