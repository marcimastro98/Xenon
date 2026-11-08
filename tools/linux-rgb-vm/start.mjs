#!/usr/bin/env node
// Runs Xenon's motherboard lighting on a real Linux kernel, in a throwaway VM, against
// a simulated GIGABYTE chip: /dev/hidraw, udev, logind and a real sleep and shutdown
// are the real ones, only the chip is not. Needs Docker and nothing else, because
// Docker's own kernel has no /dev/uhid. The first run downloads and prepares the VM.
// `start.mjs battery` runs the dongle battery readers instead, against simulated dongles.
// `start.mjs airpods` runs the AirPods reader against the real BlueZ, with virtual controllers.
// See .claude/docs/strumenti.md.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_VOLUME = 'xenon-rgb-vm';
const IMAGE = 'node:24-bookworm-slim';

const run = spawnSync('docker', [
  'run', '--rm', '-v', `${ROOT}:/repo:ro`, '-v', `${CACHE_VOLUME}:/cache`, IMAGE,
  'bash', '/repo/tools/linux-rgb-vm/run-in-docker.sh', ['battery', 'airpods'].includes(process.argv[2]) ? process.argv[2] : 'rgb',
], { stdio: 'inherit' });

if (run.error) console.error('Could not start Docker: ' + run.error.message);
process.exit(run.status ?? 1);
