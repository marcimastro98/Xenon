using System.Text;

namespace XenonHelper;

// Disk scanner + search crawler — the two walks the disk features need, one
// engine. C# because a full-drive walk in PowerShell takes minutes and a
// per-poll spawn would pay CLR startup every time; here C:\ completes in tens
// of seconds and streams while it runs.
//
// Modes (see Program.cs):
//   disk-scan <root> [detailRoot ...]   full-tree size accounting for the disk
//                                       widget (treemap, categories, dupes)
//   crawl <dir> [dir ...]               file index for the local search, over
//                                       folders Windows Search doesn't cover
//
// Output: "XEDSK " + base64(UTF8(json)) lines (base64-framed like the media
// host so no path can break the line protocol):
//   {"event":"progress","dirs":N,"files":N,"bytes":B}          (~2/s)
//   {"event":"dirs","items":[{"p","s","n","m","d"}...]}         batched
//   {"event":"files","items":[{"p","n","s","m"}...]}            batched
//   {"event":"topfiles","items":[{"p","n","s","m"}...]}         once, at end
//   {"event":"dupes","groups":[{"s",paths:[...]}...]}           once, at end
//   {"event":"done","dirs":N,"files":N,"bytes":B,"denied":N,"cancelled":bool}
//
// Safety shape: this host only ever READS. Reparse points are never traversed
// (AttributesToSkip) — a junction into the user's profile must not double the
// count or leak the target into a deletable listing. Denied directories are
// counted and skipped, never fatal. Stdin EOF cancels the walk (parent gone or
// user hit annulla) and still emits a final frame.
internal static class DiskScanHost
{
    private static readonly object OutLock = new();
    private static volatile bool Cancelled;

    // Dirs worth reporting individually: big enough for the treemap, or
    // shallow enough to give it structure. Everything still counts toward the
    // parent aggregates either way.
    private const long MinReportDirBytes = 10L * 1024 * 1024;
    private const int MaxReportDepth = 3;
    private const int DirBatch = 200;
    private const int FileBatch = 500;
    private const int MaxDetailFilesPerRoot = 20000;
    private const int TopFilesCount = 200;
    private const long DupeMinBytes = 10L * 1024 * 1024;
    private const int DupeMaxGroups = 200;
    private const int DupeMaxPerGroup = 20;
    private const int CrawlMaxFiles = 200000;

    public static int RunDiskScan(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: xenon-helper disk-scan <root> [detailRoot ...]"); return 2; }
        var root = args[1];
        var detailRoots = args.Skip(2).Select(NormalizeDir).ToArray();
        WatchStdin();

        long dirs = 0, files = 0, bytes = 0, denied = 0;
        var lastProgress = Environment.TickCount64;
        var dirItems = new List<Dictionary<string, object?>>();
        var fileItems = new List<Dictionary<string, object?>>();
        var detailCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        // Top files: min-heap by size via SortedSet keyed (size, path).
        var top = new SortedSet<(long s, string p, long m)>(Comparer<(long, string, long)>.Create((a, b) =>
            a.Item1 != b.Item1 ? a.Item1.CompareTo(b.Item1) : string.CompareOrdinal(a.Item2, b.Item2)));
        // Duplicate candidates: size → first path, then the group list.
        var sizeFirst = new Dictionary<long, string>();
        var sizeGroups = new Dictionary<long, List<string>>();

        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = false,
            AttributesToSkip = FileAttributes.ReparsePoint,   // never through a junction
            ReturnSpecialDirectories = false,
        };

        long Walk(string dir, int depth)
        {
            if (Cancelled) return 0;
            long total = 0; long newest = 0; long fileCount = 0;
            IEnumerable<FileSystemInfo> entries;
            try { entries = new DirectoryInfo(dir).EnumerateFileSystemInfos("*", opts); }
            catch { denied++; return 0; }
            foreach (var e in entries)
            {
                if (Cancelled) break;
                if ((e.Attributes & FileAttributes.ReparsePoint) != 0) continue; // belt & braces
                if (e is DirectoryInfo)
                {
                    total += Walk(e.FullName, depth + 1);
                }
                else if (e is FileInfo fi)
                {
                    long len;
                    long mt;
                    try { len = fi.Length; mt = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); }
                    catch { continue; }
                    files++; fileCount++; total += len; bytes += len;
                    if (mt > newest) newest = mt;

                    if (top.Count < TopFilesCount) top.Add((len, fi.FullName, mt));
                    else if (len > top.Min.s) { top.Remove(top.Min); top.Add((len, fi.FullName, mt)); }

                    if (len >= DupeMinBytes)
                    {
                        if (sizeGroups.TryGetValue(len, out var g)) { if (g.Count < DupeMaxPerGroup) g.Add(fi.FullName); }
                        else if (sizeFirst.TryGetValue(len, out var first)) { sizeGroups[len] = new List<string> { first, fi.FullName }; sizeFirst.Remove(len); }
                        else sizeFirst[len] = fi.FullName;
                    }

                    // Per-file detail under the roots the server asked for
                    // (Downloads, temp dirs): what the clean-preview lists.
                    foreach (var dr in detailRoots)
                    {
                        if (!IsUnder(fi.FullName, dr)) continue;
                        detailCounts.TryGetValue(dr, out var c);
                        if (c >= MaxDetailFilesPerRoot) break;
                        detailCounts[dr] = c + 1;
                        fileItems.Add(new Dictionary<string, object?> { ["p"] = fi.FullName, ["n"] = fi.Name, ["s"] = len, ["m"] = mt });
                        if (fileItems.Count >= FileBatch) FlushFiles(fileItems, "files");
                        break;
                    }
                }
            }
            dirs++;
            if (total >= MinReportDirBytes || depth <= MaxReportDepth)
            {
                dirItems.Add(new Dictionary<string, object?> { ["p"] = dir, ["s"] = total, ["n"] = fileCount, ["m"] = newest, ["d"] = depth });
                if (dirItems.Count >= DirBatch) FlushDirs(dirItems);
            }
            var now = Environment.TickCount64;
            if (now - lastProgress > 500)
            {
                lastProgress = now;
                Emit(new Dictionary<string, object?> { ["event"] = "progress", ["dirs"] = dirs, ["files"] = files, ["bytes"] = bytes });
            }
            return total;
        }

        Walk(NormalizeDir(root), 0);
        FlushDirs(dirItems);
        FlushFiles(fileItems, "files");

        var topItems = top.Reverse().Select(x => new Dictionary<string, object?>
        { ["p"] = x.p, ["n"] = Path.GetFileName(x.p), ["s"] = x.s, ["m"] = x.m }).ToList();
        Emit(new Dictionary<string, object?> { ["event"] = "topfiles", ["items"] = topItems });

        var groups = sizeGroups.OrderByDescending(kv => kv.Key).Take(DupeMaxGroups)
            .Select(kv => new Dictionary<string, object?> { ["s"] = kv.Key, ["paths"] = kv.Value }).ToList();
        Emit(new Dictionary<string, object?> { ["event"] = "dupes", ["groups"] = groups });

        Emit(new Dictionary<string, object?>
        { ["event"] = "done", ["dirs"] = dirs, ["files"] = files, ["bytes"] = bytes, ["denied"] = denied, ["cancelled"] = Cancelled });
        return 0;
    }

    public static int RunCrawl(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: xenon-helper crawl <dir> [dir ...]"); return 2; }
        WatchStdin();
        var batch = new List<Dictionary<string, object?>>();
        long emitted = 0, denied = 0;
        var opts = new EnumerationOptions
        {
            IgnoreInaccessible = true,
            RecurseSubdirectories = true,                     // flat walk is fine here
            AttributesToSkip = FileAttributes.ReparsePoint,
            MaxRecursionDepth = 16,
        };
        foreach (var rootArg in args.Skip(1))
        {
            if (Cancelled || emitted >= CrawlMaxFiles) break;
            IEnumerable<FileInfo> entries;
            try { entries = new DirectoryInfo(NormalizeDir(rootArg)).EnumerateFiles("*", opts); }
            catch { denied++; continue; }
            foreach (var fi in entries)
            {
                if (Cancelled || emitted >= CrawlMaxFiles) break;
                long len, mt;
                try { len = fi.Length; mt = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); }
                catch { continue; }
                emitted++;
                batch.Add(new Dictionary<string, object?> { ["p"] = fi.FullName, ["n"] = fi.Name, ["s"] = len, ["m"] = mt });
                if (batch.Count >= FileBatch) FlushFiles(batch, "files");
            }
        }
        FlushFiles(batch, "files");
        Emit(new Dictionary<string, object?>
        { ["event"] = "done", ["files"] = emitted, ["denied"] = denied, ["cancelled"] = Cancelled, ["truncated"] = emitted >= CrawlMaxFiles });
        return 0;
    }

    private static void FlushDirs(List<Dictionary<string, object?>> items)
    {
        if (items.Count == 0) return;
        Emit(new Dictionary<string, object?> { ["event"] = "dirs", ["items"] = new List<Dictionary<string, object?>>(items) });
        items.Clear();
    }

    private static void FlushFiles(List<Dictionary<string, object?>> items, string ev)
    {
        if (items.Count == 0) return;
        Emit(new Dictionary<string, object?> { ["event"] = ev, ["items"] = new List<Dictionary<string, object?>>(items) });
        items.Clear();
    }

    private static void WatchStdin()
    {
        new Thread(() =>
        {
            try { while (Console.In.ReadLine() != null) { } } catch { }
            Cancelled = true;
        })
        { IsBackground = true, Name = "stdin-watch" }.Start();
    }

    private static string NormalizeDir(string p)
    {
        var s = p.Replace('/', '\\');
        // "C:" alone means the process CWD on that drive; the scan wants the root.
        if (s.Length == 2 && s[1] == ':') s += "\\";
        return s;
    }

    private static bool IsUnder(string path, string prefix)
    {
        if (prefix.Length == 0) return false;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        return path.Length == prefix.Length || path[prefix.Length] == '\\' || prefix.EndsWith("\\");
    }

    private static void Emit(Dictionary<string, object?> obj)
    {
        var json = JsonOut.Serialize(obj);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        lock (OutLock)
        {
            Console.Out.WriteLine("XEDSK " + b64);
            Console.Out.Flush();
        }
    }
}
