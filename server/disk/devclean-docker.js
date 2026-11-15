'use strict';

// Docker images and build cache, through the docker CLI only. What is offered
// is exactly what `docker image prune -a` and `docker builder prune` remove:
// images no container uses and build cache. Containers and volumes hold user
// data and are reported, never offered.

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

// Docker prints decimal sizes ("5.3GB", "812.4kB", "0B", "1.2GB (45%)").
function parseDockerSize(text) {
  const m = /^\s*([\d.]+)\s*([kmgt]?b)/i.exec(String(text || ''));
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 0));
}

// `docker system df --format "{{json .}}"`: one JSON object per line.
function parseSystemDf(stdout) {
  const rows = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      rows[String(r.Type || '').toLowerCase()] = {
        count: parseInt(r.TotalCount, 10) || 0,
        bytes: parseDockerSize(r.Size),
        reclaimable: parseDockerSize(r.Reclaimable),
      };
    } catch { /* a line we do not understand is skipped, not guessed */ }
  }
  const pick = (k) => rows[k] || { count: 0, bytes: 0, reclaimable: 0 };
  return {
    images: pick('images'),
    buildCache: pick('build cache'),
    containers: pick('containers'),
    volumes: pick('local volumes'),
  };
}

// The daemon being off is a different answer from the CLI being absent: the
// first is a button away ("start Docker"), the second hides the source.
function classifyError(err) {
  if (err && err.code === 'ENOENT') return 'not_installed';
  return 'not_running';
}

function createDockerSource({ run }) {
  async function overview() {
    let out;
    try {
      out = await run('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 20000 });
    } catch (e) {
      return { available: false, reason: classifyError(e) };
    }
    const df = parseSystemDf(out.stdout);
    const items = [
      { id: 'images', kind: 'images', count: df.images.count, bytes: df.images.bytes, reclaimable: df.images.reclaimable },
      { id: 'buildCache', kind: 'buildCache', count: df.buildCache.count, bytes: df.buildCache.bytes, reclaimable: df.buildCache.reclaimable },
    ];
    return {
      available: true,
      bytes: df.images.bytes + df.buildCache.bytes + df.containers.bytes + df.volumes.bytes,
      reclaimable: items.reduce((n, it) => n + it.reclaimable, 0),
      items,
      kept: { containers: df.containers.count, volumes: df.volumes.count, volumeBytes: df.volumes.bytes },
    };
  }

  const PRUNE = {
    images: ['image', 'prune', '-a', '-f'],
    buildCache: ['builder', 'prune', '-f'],
  };

  // ids are the two fixed item ids above; anything else is ignored.
  async function clean(ids) {
    let freed = 0;
    const failed = [];
    for (const id of ids) {
      if (!PRUNE[id]) continue;
      try {
        const out = await run('docker', PRUNE[id], { timeout: 30 * 60 * 1000 });
        // image prune: "Total reclaimed space: 1.2GB"; buildx prune: "Total:  1.2GB".
        const m = /Total(?:\s+reclaimed\s+space)?:\s*(\S+)/i.exec(out.stdout || '');
        freed += m ? parseDockerSize(m[1]) : 0;
      } catch {
        failed.push(id);
      }
    }
    return { ok: failed.length === 0, freed, failed };
  }

  return { overview, clean };
}

module.exports = { createDockerSource, parseDockerSize, parseSystemDf };
