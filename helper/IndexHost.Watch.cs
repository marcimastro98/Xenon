// The file index: following changes on disk and repairing a folder that changed.

using System.IO.Enumeration;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace XenonHelper;

internal static partial class IndexHost
{
    private static void StartWatcher(string root)
    {
        try
        {
            var w = new FileSystemWatcher(root)
            {
                IncludeSubdirectories = true,
                InternalBufferSize = WatcherBufferBytes,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite,
            };
            // These four callbacks run on the watcher's own threads and must
            // return immediately: no disk, no index lock. Everything they do is
            // record the path (see rule 1 in the header).
            w.Created += (_, e) => OnFsTouch(e.FullPath, created: true);
            w.Changed += (_, e) => OnFsTouch(e.FullPath, created: false);
            w.Deleted += (_, e) => OnFsTouch(e.FullPath, created: false);
            w.Renamed += (_, e) => { OnFsTouch(e.OldFullPath, created: false); OnFsTouch(e.FullPath, created: true); };
            w.Error += (_, _) =>
            {
                MarkDirty(root);
                // A buffer overflow leaves the watcher alive, but other errors
                // leave it permanently deaf with no way to tell from here.
                // Re-arming costs nothing and a silently dead watcher is the one
                // failure this host cannot otherwise detect.
                try { w.EnableRaisingEvents = false; w.EnableRaisingEvents = true; } catch { }
            };
            w.EnableRaisingEvents = true;
            Watchers.Add(w);
        }
        catch { /* an unwatchable root degrades to build-time snapshot */ }
    }

    private static void OnFsTouch(string fullPath, bool created)
    {
        if (string.IsNullOrEmpty(fullPath)) return;
        var overflow = false;
        lock (PendingGate)
        {
            if (Pending.Count >= PendingMax) overflow = true;
            else if (created) Pending[fullPath] = true;
            else if (!Pending.ContainsKey(fullPath)) Pending[fullPath] = false;
        }
        // The queue is as bounded as the kernel's own buffer, and it answers an
        // overflow the same way: repair the root rather than grow without limit.
        if (overflow) MarkDirty(fullPath);
    }

    // Applies coalesced watcher events: one stat per touched path per pass,
    // whatever happened to it in between, and one index lock per pass.
    private static void DrainLoop()
    {
        UseEfficiencyMode();
        var touched = new List<KeyValuePair<string, bool>>(4096);
        var adds = new List<(string dir, string name, long size, long mtime)>(4096);
        var fileDeletes = new List<(string dir, string name)>();
        var subtreeDeletes = new List<string>();
        var dirWalks = new List<string>();

        while (!Cancelled)
        {
            WaitWhileHeld();
            touched.Clear(); adds.Clear(); fileDeletes.Clear(); subtreeDeletes.Clear(); dirWalks.Clear();
            lock (PendingGate)
            {
                if (Pending.Count > 0) { touched.AddRange(Pending); Pending.Clear(); }
            }
            // This thread is what gives memory back once nobody is asking —
            // see TrimHeapIfDue: a burst that ended inside the trim interval
            // would otherwise sit in the process until the next request. It
            // runs every pass, not only on an empty one: a system drive is
            // never quiet for 300 ms in a row (measured: a 2M-file C:\ kept
            // 521 MB for as long as the trim waited for an idle pass), and
            // the call is already rate-limited by bytes and by time.
            if (Ready) TrimHeapIfDue();
            if (touched.Count == 0) { Thread.Sleep(DrainIntervalMs); continue; }

            foreach (var kv in touched)
            {
                if (Cancelled) return;
                var full = kv.Key;
                try
                {
                    // Statting NOW is what makes coalescing correct: created,
                    // written and deleted between two passes reads as deleted,
                    // which is the truth.
                    var fi = new FileInfo(full);
                    if (fi.Exists)
                    {
                        if ((fi.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                        var dir = fi.DirectoryName;
                        if (dir == null) continue;
                        adds.Add((dir, fi.Name, fi.Length, new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds()));
                        continue;
                    }
                    if (Directory.Exists(full))
                    {
                        // A directory moved in arrives as ONE created event, so
                        // its contents are only ever seen by walking it.
                        if (kv.Value) dirWalks.Add(full);
                        continue;
                    }
                    // Gone. A directory the tree knows (even one that only ever
                    // held subfolders) takes its whole subtree with it.
                    bool isDirectory;
                    lock (Gate) isDirectory = ResolveDirLocked(full, create: false) >= 0;
                    if (isDirectory) { subtreeDeletes.Add(full); continue; }
                    var cut = full.LastIndexOf('\\');
                    if (cut > 0) fileDeletes.Add((full.Substring(0, cut), full.Substring(cut + 1)));
                }
                catch { /* transient fs races are the watcher's daily bread */ }
            }

            if (adds.Count > 0 || fileDeletes.Count > 0)
            {
                lock (Gate)
                {
                    foreach (var a in adds)
                    {
                        if (Entries.Count - Tombstones >= MaxEntries) { Capped = true; break; }
                        AddEntryLocked(a.dir, a.name, a.size, a.mtime);
                    }
                    foreach (var d in fileDeletes) RemoveEntryLocked(d.dir, d.name);
                }
            }
            foreach (var p in subtreeDeletes) { if (Cancelled) return; RemoveSubtree(p); }
            foreach (var d in dirWalks) { if (Cancelled) return; WalkRoot(d); }
            Thread.Sleep(DrainIntervalMs);
        }
    }

    // ── repair scheduling ─────────────────────────────────────────────────────

    private static void MarkDirty(string pathOrRoot)
    {
        var root = RootOf(pathOrRoot);
        if (root == null) return;
        var now = Environment.TickCount64;
        lock (Gate)
        {
            DirtyRoots[root] = DirtyRoots.TryGetValue(root, out var d) ? new Dirt(d.First, now) : new Dirt(now, now);
        }
    }

    private static string? RootOf(string path)
    {
        var i = RootIndexOf(path.AsSpan().TrimEnd('\\'));
        return i < 0 ? null : Roots[i];
    }

    // A root is due once the storm has stopped (or has gone on long enough to
    // stop waiting for it), and never more often than the interval. Without
    // both, one busy filesystem turns into a permanent re-walk.
    private static string? TakeDueRoot()
    {
        var now = Environment.TickCount64;
        string? due = null;
        lock (Gate)
        {
            foreach (var kv in DirtyRoots)
            {
                var quiet = now - kv.Value.Last >= RepairQuietMs;
                var waitedLongEnough = now - kv.Value.First >= RepairMaxWaitMs;
                if (!quiet && !waitedLongEnough) continue;
                if (LastRepair.TryGetValue(kv.Key, out var last) && now - last < RepairMinIntervalMs) continue;
                due = kv.Key;
                break;
            }
            if (due != null) { DirtyRoots.Remove(due); LastRepair[due] = now; }
        }
        return due;
    }

    private static void RepairRoot(string root)
    {
        var gen = Interlocked.Increment(ref WalkGen);
        Repairing = true;
        try
        {
            // A walk that stopped early saw only part of the root, so "not
            // touched" is not evidence that anything is gone. That question is
            // about THIS walk: `Capped` is a sticky whole-index report flag, so
            // gating the sweep on it disabled stale removal permanently, for
            // every root, the first time any root touched the cap — leaving
            // deleted files in the index forever, in exactly the state where the
            // index is already least accurate. The index may lag; it must never
            // stay wrong.
            var complete = WalkRoot(root, gen);
            if (!Cancelled && complete) SweepStaleUnder(root, gen);
        }
        finally
        {
            Repairing = false;
            Interlocked.Increment(ref Repairs);
        }
    }
}
