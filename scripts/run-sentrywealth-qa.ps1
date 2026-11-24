param(
    [Parameter(Mandatory)][ValidateSet('FullStack', 'Visual', 'All')][string]$Suite
)

$ErrorActionPreference = 'Stop'

# Give the runner a private console so Ctrl+C reaches its console process tree.
# DevHub's own console and independently launched services are outside that tree.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class DevHubQaConsole
{
    private delegate bool ControlHandler(uint eventType);
    private static readonly ControlHandler IgnoreInterrupt = eventType => eventType == 0;
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AllocConsole();
    [DllImport("kernel32.dll")] private static extern bool FreeConsole();
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);
    [DllImport("kernel32.dll")] private static extern bool GenerateConsoleCtrlEvent(uint eventType, uint groupId);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

    public static int Run(string powershell, string cwd, string suite)
    {
        var input = Console.In;
        var output = Console.Out;
        var errors = Console.Error;
        FreeConsole();
        if (!AllocConsole()) throw new InvalidOperationException("Could not create the QA console.");
        ShowWindow(GetConsoleWindow(), 0);
        if (!SetConsoleCtrlHandler(null, false) || !SetConsoleCtrlHandler(IgnoreInterrupt, true))
            throw new InvalidOperationException("Could not register graceful QA cancellation.");

        using (var child = new Process())
        {
            child.StartInfo = new ProcessStartInfo(powershell,
                @"-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\qa.ps1 -Suite " + suite) {
                WorkingDirectory = cwd,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            child.OutputDataReceived += (sender, args) => { if (args.Data != null) output.WriteLine(args.Data); };
            child.ErrorDataReceived += (sender, args) => { if (args.Data != null) errors.WriteLine(args.Data); };
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            var gate = new object();
            var interrupted = false;
            Task.Run(() => {
                if (input.ReadLine() != "cancel") return;
                lock (gate) {
                    if (child.HasExited) return;
                    interrupted = GenerateConsoleCtrlEvent(0, 0);
                    if (interrupted) output.WriteLine("Ctrl+C sent to the QA runner.");
                    else errors.WriteLine("Could not deliver Ctrl+C to the QA runner.");
                }
            });
            child.WaitForExit();
            // Windows PowerShell can exit with code zero after handling Ctrl+C.
            lock (gate) return interrupted ? 130 : child.ExitCode;
        }
    }
}
'@

exit [DevHubQaConsole]::Run((Join-Path $PSHOME 'powershell.exe'), (Get-Location).ProviderPath, $Suite)
