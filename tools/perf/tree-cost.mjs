// CPU and memory of a server's whole process tree and of its page, with the page open. Windows.
// It reads at the two ends of the window, so a process that starts and ends inside it is missed.
//   node tools/perf/tree-cost.mjs <port> <server pid> [settleMs] [measureMs]
import { execFileSync } from 'node:child_process';
import { browserCpu, formatCpu, withDashboard } from './browser.mjs';

const MB = 1024 * 1024;
const TICKS_PER_SECOND = 1e7;
const ROW_FIELDS = 'ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount,CommandLine';

function processes() {
  const command = `Get-CimInstance Win32_Process | Select-Object ${ROW_FIELDS} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', maxBuffer: 1 << 27 }));
}

function treeOf(list, root) {
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { ProcessId, ParentProcessId } of list) {
      if (tree.has(ParentProcessId) && !tree.has(ProcessId)) { tree.add(ProcessId); grew = true; }
    }
  }
  return tree;
}

const busyTicks = (row) => Number(row.KernelModeTime) + Number(row.UserModeTime);

function report(before, after, root, seconds) {
  const tree = treeOf(after, root);
  const earlier = new Map(before.map((row) => [row.ProcessId, row]));
  const rows = after.filter((row) => tree.has(row.ProcessId)).map((row) => {
    const old = earlier.get(row.ProcessId);
    const share = ((busyTicks(row) - (old ? busyTicks(old) : 0)) / TICKS_PER_SECOND / seconds) * 100;
    const args = (row.CommandLine || '').replace(/^.*?\.exe"?\s*/i, '').slice(0, 50);
    return { share, text: `${row.Name} ${args}`, private: row.PrivatePageCount / MB };
  }).sort((a, b) => b.share - a.share);
  console.log(`server tree: ${rows.reduce((sum, row) => sum + row.share, 0).toFixed(2)}% of a core over ${seconds.toFixed(0)} s`);
  for (const row of rows) console.log(`${row.share.toFixed(2).padStart(6)}%  ${row.private.toFixed(0).padStart(5)} MB private  ${row.text}`);
}

async function main() {
  const [port, pid, settleMs = '20000', measureMs = '30000'] = process.argv.slice(2);
  if (!port || !pid) throw new Error('usage: node tools/perf/tree-cost.mjs <port> <server pid> [settleMs] [measureMs]');
  await withDashboard(port, async ({ browser, page }) => {
    await page.waitForTimeout(Number(settleMs));
    const before = processes();
    const startedAt = Date.now();
    const pageCpu = await browserCpu(browser, page, Number(measureMs));
    report(before, processes(), Number(pid), (Date.now() - startedAt) / 1000);
    console.log('page:', formatCpu(pageCpu));
    console.log('body:', await page.evaluate(() => document.body.className));
  });
}

await main();
