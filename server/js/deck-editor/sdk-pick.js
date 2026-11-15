// The fields of the deck editor for a key that runs something of a widget: the choice of the
// widget's macro and the fields its handler asks for.
'use strict';

window.DeckEditorSdkPick = (wrapper) => {
    const { enhanceSelects, field, input, sdkHandlers, sdkMacros, t } = wrapper;

    // A param control for the sdkMacro kind: a dropdown of the macros installed
    // widget packages contribute ({value:'pkg/macroId', label:'Widget › Macro'}).
    // A typed ref field is the fallback when no package is readable, so an
    // already-assigned macro is never lost (mirrors sbActionPickControl).
    function sdkMacroPickControl(step, name) {
      const wrap = document.createElement('div');
      const txt = input('text', step.params[name] || '');
      txt.placeholder = t('deck_param_macro');
      const writeTxt = () => { step.params[name] = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      sdkMacros().then((items) => {
        if (!items || !items.length) return;   // none installed → typed ref field only
        const sel = document.createElement('select'); sel.className = 'deck-ed-input';
        const cur = step.params[name] || '';
        if (cur && !items.some((it) => it.value === cur)) items = [{ value: cur, label: cur }, ...items];
        items.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
        sel.value = cur || items[0].value;
        step.params[name] = sel.value;
        sel.addEventListener('change', () => { step.params[name] = sel.value; });
        wrap.replaceChildren(sel);
        enhanceSelects(wrap);   // package list arrived → style its dropdown too
      }).catch(() => {});
      return wrap;
    }

    // The whole-action control for sdkHandler: a dropdown of the handler actions
    // installed packages contribute PLUS an auto-generated form for the chosen
    // handler's manifest-declared params (text/select/number). The form's values
    // serialize into step.params.args as JSON — the exact string the server
    // re-coerces through validateHandlerArgs at run time.
    function sdkHandlerParams(host, step) {
      if (step.params.handler == null) step.params.handler = '';
      if (step.params.args == null) step.params.args = '';
      const fH = field('deck_param_handler');
      const wrap = document.createElement('div');
      const txt = input('text', step.params.handler);   // typed-ref fallback (packages unreadable)
      txt.placeholder = t('deck_param_handler');
      const writeTxt = () => { step.params.handler = txt.value; };
      txt.addEventListener('input', writeTxt); txt.addEventListener('change', writeTxt);
      wrap.appendChild(txt);
      fH.appendChild(wrap);
      const argsHost = document.createElement('div');
      const readArgs = () => {
        try { const o = JSON.parse(step.params.args || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
        catch { return {}; }
      };
      const renderHandlerArgs = (items) => {
        argsHost.replaceChildren();
        const it = (items || []).find((x) => x.value === step.params.handler);
        const params = (it && it.params) || [];
        if (!params.length) { step.params.args = ''; return; }
        const cur = readArgs();
        const next = {};
        const write = () => { step.params.args = JSON.stringify(next); };
        params.forEach((p) => {
          const pf = document.createElement('div'); pf.className = 'deck-ed-subfield';
          const lbl = document.createElement('span'); lbl.className = 'deck-ed-label';
          lbl.textContent = p.label || p.name;   // untrusted manifest text → textContent
          pf.appendChild(lbl);
          if (p.kind === 'select') {
            const sel = document.createElement('select'); sel.className = 'deck-ed-input';
            (p.options || []).forEach((o) => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; sel.appendChild(opt); });
            sel.value = (p.options || []).includes(cur[p.name]) ? cur[p.name] : (p.options || [])[0] || '';
            next[p.name] = sel.value;
            sel.addEventListener('change', () => { next[p.name] = sel.value; write(); });
            pf.appendChild(sel);
          } else if (p.kind === 'number') {
            const num = input('number', cur[p.name] != null ? String(cur[p.name]) : '');
            if (p.min != null) num.min = String(p.min);
            if (p.max != null) num.max = String(p.max);
            if (cur[p.name] != null) next[p.name] = Number(cur[p.name]);
            const w = () => { const n = Number(num.value); if (Number.isFinite(n)) next[p.name] = n; else delete next[p.name]; write(); };
            num.addEventListener('input', w); num.addEventListener('change', w);
            pf.appendChild(num);
          } else {
            const ti = input('text', cur[p.name] != null ? String(cur[p.name]) : '');
            ti.maxLength = 200;   // = HANDLER_ARG_TEXT_MAX, the server's per-value delivery cap
            if (cur[p.name] != null) next[p.name] = String(cur[p.name]);
            const w = () => { if (ti.value) next[p.name] = ti.value; else delete next[p.name]; write(); };
            ti.addEventListener('input', w); ti.addEventListener('change', w);
            pf.appendChild(ti);
          }
          argsHost.appendChild(pf);
        });
        write();
        enhanceSelects(argsHost);
      };
      sdkHandlers().then((items) => {
        if (items && items.length) {
          const sel = document.createElement('select'); sel.className = 'deck-ed-input';
          const cur = step.params.handler || '';
          let list = items;
          if (cur && !list.some((it) => it.value === cur)) list = [{ value: cur, label: cur, params: [] }, ...list];
          list.forEach((it) => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
          sel.value = cur || list[0].value;
          step.params.handler = sel.value;
          sel.addEventListener('change', () => { step.params.handler = sel.value; step.params.args = ''; renderHandlerArgs(list); });
          wrap.replaceChildren(sel);
          enhanceSelects(wrap);
          renderHandlerArgs(list);
        }
      }).catch(() => {});
      host.appendChild(fH);
      host.appendChild(argsHost);
    }

    return { sdkMacroPickControl, sdkHandlerParams };
};
