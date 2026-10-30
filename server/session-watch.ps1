# -------------------------------------------------------------------------
# Session watch - tells the server when Windows is about to shut down, restart,
# sign out or go to sleep (see session-watch.js for why the server needs this).
#
# A hidden top-level window is the only thing Windows asks before ending the
# session (WM_QUERYENDSESSION) or suspending (WM_POWERBROADCAST); a process with
# no window, like node, is simply terminated. On each event one word goes to
# stdout: "ending", "suspend" or "resume". For "ending" and "suspend" Windows is
# held until the server answers "done" on stdin, at most AckWaitMs, so the PC
# never waits on a server that is stuck. When stdin closes (the server went
# away) this host exits with it.
# -------------------------------------------------------------------------
param(
  [int]$AckWaitMs = 2500
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class XenonSessionWatch : NativeWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool ShutdownBlockReasonCreate(IntPtr h, string reason);
  [DllImport("user32.dll")] static extern bool ShutdownBlockReasonDestroy(IntPtr h);

  const int WM_QUERYENDSESSION = 0x0011;
  const int WM_ENDSESSION = 0x0016;
  const int WM_POWERBROADCAST = 0x0218;
  const int PBT_APMSUSPEND = 0x0004;
  const int PBT_APMRESUMESUSPEND = 0x0007;
  const int PBT_APMRESUMEAUTOMATIC = 0x0012;
  const long ENDSESSION_CLOSEAPP = 0x1;   // Restart Manager closing this app, not the session ending

  readonly int ackWaitMs;
  readonly AutoResetEvent ack = new AutoResetEvent(false);
  bool ended;
  bool suspended;

  public XenonSessionWatch(int ackWaitMs) {
    this.ackWaitMs = ackWaitMs;
    CreateHandle(new CreateParams());   // hidden top-level: it receives the session broadcasts
    Thread reader = new Thread(ReadAcks);
    reader.IsBackground = true;
    reader.Start();
  }

  void ReadAcks() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim() == "done") ack.Set();
    }
    Environment.Exit(0);   // the server is gone: nothing left to tell
  }

  void Emit(string word) {
    Console.Out.WriteLine(word);
    Console.Out.Flush();
  }

  // Tell the server and give it a bounded moment to hand the lights back.
  void EmitAndWait(string word, bool blockShutdown) {
    ack.Reset();
    if (blockShutdown) ShutdownBlockReasonCreate(Handle, "Xenon is handing the lights back");
    Emit(word);
    ack.WaitOne(ackWaitMs);
    if (blockShutdown) ShutdownBlockReasonDestroy(Handle);
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_QUERYENDSESSION || (m.Msg == WM_ENDSESSION && m.WParam != IntPtr.Zero)) {
      bool closeApp = (m.LParam.ToInt64() & ENDSESSION_CLOSEAPP) != 0;
      if (!ended && !closeApp) {
        ended = true;
        EmitAndWait("ending", true);
      }
      m.Result = (IntPtr)1;
      return;
    }
    if (m.Msg == WM_ENDSESSION) {
      ended = false;   // the shutdown was cancelled: a later one is reported again
    } else if (m.Msg == WM_POWERBROADCAST) {
      int ev = m.WParam.ToInt32();
      if (ev == PBT_APMSUSPEND && !suspended) {
        suspended = true;
        EmitAndWait("suspend", false);
      } else if ((ev == PBT_APMRESUMESUSPEND || ev == PBT_APMRESUMEAUTOMATIC) && suspended) {
        suspended = false;
        Emit("resume");
      }
      m.Result = (IntPtr)1;
      return;
    }
    base.WndProc(ref m);
  }
}
"@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms -WarningAction SilentlyContinue
$watch = New-Object XenonSessionWatch $AckWaitMs
[System.Windows.Forms.Application]::Run()
