# Xenon — Native iCUE Widgets (Phase 1 deliverable)

Native iCUE HTML widgets for the CORSAIR Xeneon Edge, converted faithfully from the
production Xenon web dashboard. Open **Xenon-Widgets.html** for the visual gallery.

## Contents

- `xenon-clock.icuewidget` — **Clock** (Phase 1)
- `xenon-system.icuewidget` — **System Monitor** (Phase 1)
- `xenon-fps.icuewidget` — **In-game FPS** (Phase 1)
- `xenon-notes.icuewidget` — **Notes** (Phase 1)
- `xenon-tasks.icuewidget` — **Tasks** (Phase 1)
- `xenon-timers.icuewidget` — **Timers** (Phase 1)
- `xenon-calendar.icuewidget` — **Calendar** (Phase 1)
- `xenon-media.icuewidget` — **Media (preview)** (Phase 2 preview)

## Install

Import each `.icuewidget` through iCUE's widget import. All tiles appear under the
**Xenon** group in the widget picker. Each widget personalizes via the standard iCUE
text / accent / background / transparency properties and is multilingual (EN/IT/KO/JA/ZH).

## Status note

Widgets are verified at the three Xeneon Edge canvas sizes in the QtWebEngine-equivalent
browser. On-device verification inside iCUE is currently blocked by an iCUE 5.47.101 crash
when adding any HTML widget to the Xeneon Edge (reproduces with CORSAIR's own sample
widgets) — an iCUE/Edge issue, not a widget defect.
