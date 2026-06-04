'use strict';

async function safe(promise, fallback) {
  try { return await promise; } catch { return fallback; }
}

async function buildState({ installer, tailscale, sunshine, service, selectedScreen = '' }) {
  const [sunshineInstalled, tailscaleInstalled, tsStatus, sunResponding] = await Promise.all([
    safe(installer.isInstalled('sunshine'), false),
    safe(installer.isInstalled('tailscale'), false),
    safe(tailscale.getStatus(), { installed: false, connected: false, ip: '' }),
    safe(sunshine.isResponding(), false),
  ]);

  const connectedClients = sunResponding ? await safe(sunshine.listClients(), []) : [];
  const ready = sunshineInstalled && tailscaleInstalled && tsStatus.connected && sunResponding;

  let blocked = false;
  if (service) {
    const running = await safe(service.isRunning(), true);
    blocked = !running;
  }

  return {
    ready,
    installed: { sunshine: sunshineInstalled, tailscale: tailscaleInstalled },
    tailscale: tsStatus,
    sunshineResponding: sunResponding,
    connectedClients,
    blocked,
    selectedScreen,
  };
}

module.exports = { buildState };
