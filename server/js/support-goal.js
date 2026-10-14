'use strict';

// ── "Xenon pays for itself": the supporter count and its goal ──────────────
//
// One line and one bar, drawn from GET /api/community/support-goal: two public
// integers the supporter hub publishes (people paying right now, and how many it
// takes to cover the running costs), cached an hour by the local server. Shared
// by the December appeal (js/support-appeal.js) and the Settings support page,
// so the two can never show different numbers.
//
// It never invents a number. When the count cannot be read the element stays
// hidden: a goal bar with a guessed figure in it is a claim nobody can check.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function cleanGoal(d) {
    const active = Number(d && d.active);
    if (!d || d.ok !== true || !Number.isInteger(active) || active < 0) return null;
    const target = Number(d.target);
    return { active, target: Number.isInteger(target) && target > 0 ? target : null };
  }

  async function load() {
    try {
      const r = await fetch('/api/community/support-goal', { cache: 'no-store' });
      return cleanGoal(await r.json());
    } catch { return null; }
  }

  // The one state where "it does not pay for itself yet" is true and checkable.
  // No count is not short, and neither is a goal already reached.
  function shortOfGoal(goal) {
    return !!(goal && goal.target && goal.active < goal.target);
  }

  function lineText(goal) {
    const n = String(goal.active);
    if (shortOfGoal(goal)) {
      return t('support_goal_line', "Xenon pays for itself at {target} supporters. Right now we're at {n}.")
        .replace('{target}', String(goal.target)).replace('{n}', n);
    }
    // Reached. People give less once a goal is met, and a full bar says "done",
    // so past it the line thanks them and says where anything more goes.
    if (goal.target) {
      return t('support_goal_met', 'Xenon pays for itself thanks to {n} supporters. Anything beyond that becomes time to make it better.')
        .replace('{n}', n);
    }
    return t('support_goal_count', 'Xenon has {n} supporters right now.').replace('{n}', n);
  }

  // Fills `box` (an element holding a `.support-goal-line` and a <progress>)
  // and shows it, or keeps it hidden when there is nothing true to show.
  function render(box, goal) {
    if (!box) return;
    const line = box.querySelector('.support-goal-line');
    const bar = box.querySelector('progress');
    if (!goal || !line) { box.hidden = true; return; }
    line.textContent = lineText(goal);
    if (bar) {
      // Only while short of the goal, so it never shows full or past full.
      const short = shortOfGoal(goal);
      bar.hidden = !short;
      if (short) {
        bar.max = goal.target;
        bar.value = goal.active;
        bar.setAttribute('aria-label', line.textContent);
      }
    }
    box.hidden = false;
  }

  async function fill(box) {
    if (!box) return;
    render(box, await load());
  }

  window.XenonSupportGoal = { load, render, fill, shortOfGoal };
})();
