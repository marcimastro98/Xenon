using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace XenonHelper;

// Recycle-bin delete — the ONLY way Xenon ever removes user files, and it is
// deliberately not a permanent delete: SHFileOperationW with FOF_ALLOWUNDO
// sends everything to the Recycle Bin, so the Bin itself is the undo. One
// exception, explicit by name: emptying the Recycle Bin, whose contents are
// already the leftovers of previous deletes.
//
// One-shot mode: reads a single JSON line from stdin —
//   {"paths":["C:\\...","..."]}     → recycle those paths
//   {"emptyRecycleBin":true}        → SHEmptyRecycleBin (no confirm UI)
// prints one bare JSON line {"ok":bool,"rc":N,"aborted":bool} and exits. The
// server (diskspace.js) is the authority on WHAT may be deleted: every path
// was resolved from its own enumeration and re-checked against the guard
// blocklist immediately before this process was spawned; this side only
// refuses shapes that could never be legitimate (relative paths, wildcards).
internal static class ShellDelete
{
    private const uint FO_DELETE = 0x0003;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_SILENT = 0x0004;
    private const ushort FOF_NOERRORUI = 0x0400;

    private const uint SHERB_NOCONFIRMATION = 0x1;
    private const uint SHERB_NOPROGRESSUI = 0x2;
    private const uint SHERB_NOSOUND = 0x4;

    public static int Run()
    {
        string? line;
        try { line = Console.In.ReadLine(); } catch { line = null; }
        if (string.IsNullOrWhiteSpace(line)) { Print(false, -1, false); return 1; }

        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;

            if (root.TryGetProperty("emptyRecycleBin", out var erb) && erb.ValueKind == JsonValueKind.True)
            {
                // Empty EACH fixed drive's bin on its own, not all-at-once with a
                // null root. A null root asks Windows to empty every drive's bin
                // in one call, and a single drive that can't be emptied (a file
                // in use, a bin that is already empty and answers E_UNEXPECTED)
                // failed the WHOLE call — so a bin that really did clear reported
                // empty_failed and the user saw nothing change. Per-drive, we
                // succeed if every drive either cleared or was already empty, and
                // only report failure for the drive that genuinely refused.
                int worst = 0;              // first genuinely-bad hr, for the caller
                bool anyRealFailure = false;
                foreach (var drive in DriveInfo.GetDrives())
                {
                    if (drive.DriveType != DriveType.Fixed) continue;
                    int hr;
                    try { hr = SHEmptyRecycleBinW(IntPtr.Zero, drive.Name, SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND); }
                    catch { continue; }     // a drive we cannot touch is not a failure of the others
                    // Then sweep ORPHANED entries the API leaves behind: a $R
                    // (deleted content) whose $I (metadata twin) is gone. Such a
                    // pair is a half-finished delete — Explorer doesn't even show
                    // it, and SHEmptyRecycleBin skips it, so it sits there eating
                    // space forever (the "empty leaves 900 MB" bug, itself caused
                    // by an earlier empty that was killed mid-run). Removing a $R
                    // with no $I is safe: with no metadata it is unrecoverable
                    // already, so this is finishing the delete, not starting one.
                    try { PurgeOrphanedRecycleEntries(drive.Name); } catch { /* best effort */ }
                    // S_OK, or the documented "already empty" answer (E_UNEXPECTED
                    // on a drive whose bin holds nothing), are fine. Everything
                    // else — including 0x80070091 "directory not empty", a file in
                    // use — is a real refusal for that drive.
                    if (hr == 0 || hr == unchecked((int)0x8000FFFF)) continue;
                    anyRealFailure = true;
                    if (worst == 0) worst = hr;
                }
                Print(!anyRealFailure, worst, false);
                return anyRealFailure ? 1 : 0;
            }

            if (!root.TryGetProperty("paths", out var arr) || arr.ValueKind != JsonValueKind.Array)
            { Print(false, -2, false); return 1; }

            var paths = new List<string>();
            foreach (var el in arr.EnumerateArray())
            {
                var p = el.GetString();
                if (string.IsNullOrEmpty(p)) continue;
                // Absolute local drive paths only, no wildcards — anything else
                // is a caller bug and refuses the whole batch (fail closed).
                if (p.Length < 4 || !char.IsLetter(p[0]) || p[1] != ':' || (p[2] != '\\' && p[2] != '/'))
                { Print(false, -3, false); return 1; }
                if (p.IndexOf('*') >= 0 || p.IndexOf('?') >= 0) { Print(false, -3, false); return 1; }
                paths.Add(p.Replace('/', '\\'));
            }
            if (paths.Count == 0) { Print(true, 0, false); return 0; }

            // SHFileOperation takes a double-null-terminated list of paths.
            var joined = new StringBuilder();
            foreach (var p in paths) { joined.Append(p); joined.Append('\0'); }
            joined.Append('\0');

            var op = new SHFILEOPSTRUCTW
            {
                hwnd = IntPtr.Zero,
                wFunc = FO_DELETE,
                pFrom = joined.ToString(),
                pTo = null,
                fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            };
            var rc = SHFileOperationW(ref op);
            Print(rc == 0 && !op.fAnyOperationsAborted, rc, op.fAnyOperationsAborted);
            return rc == 0 ? 0 : 1;
        }
        catch
        {
            Print(false, -4, false);
            return 1;
        }
    }

    // Delete $R entries under <drive>\$Recycle.Bin\<SID>\ that have lost their
    // $I metadata twin. Strictly bounded: we only ever look inside
    // "<drive>:\$Recycle.Bin", only act on names starting with "$R", and only
    // when the exact "$I" + same-suffix sibling is absent. A $R WITH its $I is a
    // real, restorable bin entry and is never touched here — SHEmptyRecycleBin
    // owns those. Uses the \\?\ prefix so a deep tree deletes without MAX_PATH
    // trouble.
    private static void PurgeOrphanedRecycleEntries(string driveRoot)
    {
        // driveRoot is like "C:\". Build "C:\$Recycle.Bin".
        var binRoot = Path.Combine(driveRoot, "$Recycle.Bin");
        if (!Directory.Exists(binRoot)) return;

        foreach (var sidDir in SafeEnumerateDirs(binRoot))
        {
            // Index the $I names present so an orphan check is O(1).
            var haveMeta = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var rContent = new List<string>();
            foreach (var entry in SafeEnumerateFileSystem(sidDir))
            {
                var name = Path.GetFileName(entry);
                if (name.Length < 2) continue;
                if (name[0] == '$' && (name[1] == 'I' || name[1] == 'i')) haveMeta.Add(name.Substring(2));
                else if (name[0] == '$' && (name[1] == 'R' || name[1] == 'r')) rContent.Add(entry);
            }
            foreach (var rPath in rContent)
            {
                var suffix = Path.GetFileName(rPath).Substring(2);
                if (haveMeta.Contains(suffix)) continue;   // has its twin → a real entry, leave it
                DeleteHard(rPath);
            }
        }
    }

    private static IEnumerable<string> SafeEnumerateDirs(string dir)
    {
        try { return Directory.EnumerateDirectories(dir); } catch { return System.Array.Empty<string>(); }
    }
    private static IEnumerable<string> SafeEnumerateFileSystem(string dir)
    {
        try { return Directory.EnumerateFileSystemEntries(dir); } catch { return System.Array.Empty<string>(); }
    }

    // Permanent delete of a file or a whole directory tree, via the \\?\ prefix
    // so long paths inside a cache tree do not stop it. Best-effort per node.
    private static void DeleteHard(string path)
    {
        const string pfx = @"\\?\";
        try
        {
            if (Directory.Exists(path))
            {
                foreach (var child in SafeEnumerateFileSystem(path)) DeleteHard(child);
                ClearReadOnly(path);   // a read-only DIR also blocks its own removal
                try { Directory.Delete(pfx + path); } catch { try { Directory.Delete(path); } catch { } }
            }
            else
            {
                ClearReadOnly(path);
                try { File.Delete(pfx + path); } catch { try { File.Delete(path); } catch { } }
            }
        }
        catch { /* one stubborn node must not stop the sweep */ }
    }

    // Clear ONLY the read-only bit (not via FileAttributes.Normal, which is the
    // "no other attributes" sentinel and does not reliably clear read-only on a
    // file that also carries Archive/Hidden). Try both plain and \\?\ forms so a
    // long path is covered too.
    private static void ClearReadOnly(string path)
    {
        foreach (var p in new[] { path, @"\\?\" + path })
        {
            try
            {
                var a = File.GetAttributes(p);
                if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(p, a & ~FileAttributes.ReadOnly);
                return;
            }
            catch { /* try the other form */ }
        }
    }

    private static void Print(bool ok, int rc, bool aborted)
    {
        Console.Out.WriteLine(JsonOut.Serialize(new Dictionary<string, object?>
        { ["ok"] = ok, ["rc"] = rc, ["aborted"] = aborted }));
        Console.Out.Flush();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCTW
    {
        public IntPtr hwnd;
        // UINT in the Win32 header, not WORD. Declaring it ushort left the two
        // high bytes as padding the marshaller is not required to zero, so
        // shell32 could read something other than FO_DELETE and fail the whole
        // batch on some machines and not others. fFlags below IS a WORD
        // (FILEOP_FLAGS) and correctly stays ushort.
        public uint wFunc;
        [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperationW(ref SHFILEOPSTRUCTW op);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHEmptyRecycleBinW(IntPtr hwnd, string? pszRootPath, uint dwFlags);
}
