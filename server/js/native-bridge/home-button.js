// The round button the kiosk collapses to when it goes home: its stylesheet and its element with
// the Xenon mark and the way-back label.
'use strict';

window.NativeBridgeHomeButton = (wrapper) => {
    const { HOME_CLASS, SERVER, tr } = wrapper;

    // Native-only UI, so inject it here rather than shipping it in index.html.
    // In home mode the OS window itself IS a small round button (see the shell's
    // monitor.rs, which sizes it to a circle and clips it round) — so this
    // overlay just fills the whole window as one circular button face: every
    // pixel is tappable, showing only the Xenon logo mark. The accessible label
    // ("Tap to return to Xenon") stays on the element for screen readers.
    // The face adapts to the OS window the shell gives us: the current shell
    // shrinks to a small circle (round button, logo only), while an older shell
    // still uses a full-width strip — there the same element renders as a flat
    // bar with the label, instead of a grotesquely stretched "circle". A media
    // query on the viewport width is all it takes to tell them apart.
    const style = document.createElement('style');
    style.textContent = [
      '#xenon-home-bar{position:fixed;inset:0;z-index:2147483000;display:none;',
      'align-items:center;justify-content:center;gap:8px;box-sizing:border-box;',
      'touch-action:none;cursor:pointer;',
      '-webkit-user-select:none;user-select:none;color:#f3f5f7;',
      'font:600 12px/1 Inter,system-ui,-apple-system,sans-serif;',
      // Clean dark-slate face (not a muddy black orb) so the white/purple/blue
      // brand mark pops; a thin accent ring + top highlight read it as a button.
      'background:radial-gradient(125% 125% at 50% 30%,#1b2431,#0a0e13);',
      'box-shadow:inset 0 1px 0 rgba(255,255,255,0.10),',
      'inset 0 0 0 1.5px rgba(var(--accent-rgb,80,200,180),0.55);',
      'transition:transform .12s ease;}',
      '#xenon-home-bar:active{transform:scale(0.93);}',
      'body.' + HOME_CLASS + '{overflow:hidden;}',
      'body.' + HOME_CLASS + ' #xenon-home-bar{display:flex;}',
      // While collapsed to the round button, hide the dashboard entirely: the
      // OS window is a small circle but the bar fills it as a square with rounded
      // corners, so any fixed dashboard chrome (the floating "Layout" button, the
      // ticker…) would otherwise peek through the bar's transparent corners AND
      // stay clickable behind it. Hidden + non-interactive, nothing shows or can
      // be hit behind the button; the webview itself stays alive.
      'body.' + HOME_CLASS + ' .shell{visibility:hidden;pointer-events:none;}',
      '#xenon-home-bar .xhb-logo{flex:0 0 auto;object-fit:contain;pointer-events:none;',
      'filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45));}',
      // Round-button window (current shell): circle, the logo fills most of it.
      '@media (max-width:200px){',
      '#xenon-home-bar{border-radius:50%;}',
      '#xenon-home-bar .xhb-logo{width:58%;height:58%;}',
      '#xenon-home-bar .xhb-label{display:none;}',
      '}',
      // Full-width strip window (older shell): flat bar, small logo + label.
      '@media (min-width:201px){',
      '#xenon-home-bar .xhb-logo{width:22px;height:22px;}',
      '}'
    ].join('');
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'xenon-home-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', tr('native_home_return', 'Tap to return to Xenon'));
    bar.setAttribute('title', tr('native_home_return', 'Tap to return to Xenon'));
    // The Xenon "X" brand mark (served PNG), so the round button is unmistakably
    // Xenon rather than a vague dark blob. It's injected at full-screen and cached
    // by the webview, so it's already painted by the time an up-swipe collapses
    // the window to the round handle.
    const barLogo = document.createElement('img');
    barLogo.className = 'xhb-logo';
    barLogo.src = SERVER + '/public/images/logo/logo-mark.png';
    barLogo.alt = '';
    barLogo.setAttribute('aria-hidden', 'true');
    bar.appendChild(barLogo);
    // Visible only on the old shell's full-width strip (hidden on the circle).
    const barLabel = document.createElement('span');
    barLabel.className = 'xhb-label';
    barLabel.textContent = tr('native_home_return', 'Tap to return to Xenon');
    bar.appendChild(barLabel);
    (document.body || document.documentElement).appendChild(bar);

    return { bar };
};
