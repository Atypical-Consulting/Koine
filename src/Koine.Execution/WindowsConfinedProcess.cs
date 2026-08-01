using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Koine.Execution;

/// <summary>
/// The Windows half of the scenario child's filesystem confinement (issue #1780): a primary token
/// duplicated from the caller's own and relabelled LOW INTEGRITY, under which the child is created
/// directly with <c>CreateProcessAsUser</c> and three hand-plumbed pipes.
///
/// <para><b>Why low integrity and not a sandbox profile.</b> Windows' mandatory integrity control denies
/// a low-IL process write access to any object carrying a higher mandatory label — which is everything
/// the user owns — while leaving READS open. That asymmetry is not a compromise here: it is exactly the
/// rule ADR 0012 already committed to on macOS and Linux, because the child must load the .NET shared
/// framework and its own assemblies from outside its run directory. The per-run directory is given an
/// explicit low mandatory label (see <see cref="TryLabelRunDirectory"/>) so the child keeps the one
/// place it is meant to write, mirroring the macOS profile's <c>(allow file-write* (subpath …))</c>.</para>
///
/// <para><b>Why NOT an AppContainer, and why the network stays open.</b> Both were measured on a real
/// kernel before either was chosen (issue #1780, task 1). Low integrity does not deny sockets. An
/// AppContainer with no capabilities does — it is the only unprivileged mechanism that does — but an
/// AppContainer child could not read the koine binary's own directory, which is where the real child
/// lives (a dotnet-tools directory, or Studio's sidecar), so it would not start at all. Buying the
/// network half would mean persistently rewriting the permissions of an install directory OUTSIDE the
/// run directory from an editor click. So the network is reported as unenforced rather than faked —
/// <see cref="ScenarioSandbox.NetworkConfinementAvailable"/> stays false here, and the plan says so.</para>
///
/// <para><b>Why this cannot be <c>Process.Start</c>.</b> A custom token can only be supplied at creation,
/// through <c>CreateProcessAsUser</c>, which .NET does not expose. So the three redirected pipes the
/// stdio protocol needs are built by hand. The host-side end of every pipe is marked NON-inheritable —
/// leave it inheritable and the child holds the far end open, so the host's read never sees EOF.</para>
///
/// <para><b>A race this path closes.</b> The child is created <c>CREATE_SUSPENDED</c>, so the caller can
/// attach the <see cref="WindowsJobObject"/> before its first instruction and only then
/// <see cref="Resume"/> — the start-up window <see cref="WindowsJobObject"/>'s own doc comment documents
/// as accepted on the <c>Process.Start</c> path.</para>
///
/// <para>Nothing here throws: every failure returns <c>null</c>/<c>false</c> with a reason, and the
/// caller falls back to an unconfined <c>Process.Start</c> plus a note. That is the contract from #1759
/// and ADR 0012 — confinement never turns a working scenario into a failed one.</para>
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsConfinedProcess : IDisposable
{
    /// <summary>How long the availability probe gets. Same budget as every other mechanism's probe
    /// (<see cref="ScenarioSandbox.MaxProbeCost"/> accounts for it): the probe runs a no-op command, so
    /// anything slower than this is a wedged mechanism rather than a slow one.</summary>
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Whether this host can actually create a confined child — probed ONCE against a trivial command
    /// and cached, never assumed. A machine whose policy refuses the token, or whose desktop refuses a
    /// low-integrity process, must be found here rather than by a user whose scenario stopped working.
    /// </summary>
    private static readonly Lazy<bool> Probed = new(Probe);

    /// <summary>Why the probe said no, or <c>null</c> when it said yes (or has not run). Folded into the
    /// degradation note, so "Windows could not confine this run" always carries the step that refused
    /// rather than leaving the reader — and the next maintainer — to guess.</summary>
    private static string? _probeFailure;
    private readonly SafeProcessHandle _thread;

    private WindowsConfinedProcess(
        Process process,
        SafeProcessHandle thread,
        StreamWriter standardInput,
        StreamReader standardOutput,
        StreamReader standardError)
    {
        Process = process;
        _thread = thread;
        StandardInput = standardInput;
        StandardOutput = standardOutput;
        StandardError = standardError;
    }

    /// <summary>See <see cref="Probed"/>. Cheap after the first call; never throws.</summary>
    public static bool Available => Probed.Value;

    /// <summary>See <see cref="_probeFailure"/>. Only meaningful once <see cref="Available"/> has been
    /// read and came back <c>false</c>.</summary>
    public static string? ProbeFailure => _probeFailure;

    /// <summary>The child, suspended until <see cref="Resume"/>. Carries the same <c>Id</c>,
    /// <c>ExitCode</c>, <c>WaitForExit</c> and <c>Kill(entireProcessTree: true)</c> surface the host
    /// already drives, and is assignable to a <see cref="WindowsJobObject"/>.</summary>
    public Process Process { get; }

    public StreamWriter StandardInput { get; }

    public StreamReader StandardOutput { get; }

    public StreamReader StandardError { get; }

    /// <summary>Lets the child run. Called AFTER the Job Object is attached, which is the whole point of
    /// creating it suspended.</summary>
    public void Resume()
    {
        // A resume that fails leaves a suspended child that will hit the wall-clock deadline and be
        // killed — bad, but not worth throwing over: the host reports the timeout either way.
        _ = ResumeThread(_thread);
    }

    public void Dispose()
    {
        try
        {
            StandardInput.Dispose();
            StandardOutput.Dispose();
            StandardError.Dispose();
        }
        catch (Exception)
        {
            // A stream the child already tore down is nothing to fail a run over.
        }

        _thread.Dispose();
        Process.Dispose();
    }

    /// <summary>
    /// Starts <paramref name="startInfo"/>'s command under a low-integrity token, SUSPENDED, with all
    /// three streams redirected — or <c>null</c> with the reason in <paramref name="failure"/>, in which
    /// case the caller must fall back to an unconfined <see cref="Process.Start(ProcessStartInfo)"/>.
    /// </summary>
    public static WindowsConfinedProcess? TryStart(ProcessStartInfo startInfo, out string? failure)
    {
        failure = null;
        SafeAccessTokenHandle? token = TryCreateToken(out failure);
        if (token is null)
        {
            return null;
        }

        using (token)
        {
            return TryStart(token, startInfo, out failure);
        }
    }

    /// <summary>
    /// Gives <paramref name="runDirectory"/> a LOW mandatory label, so the confined child keeps the one
    /// place it is meant to write. Written through <c>LABEL_SECURITY_INFORMATION</c>, which — unlike
    /// <c>SACL_SECURITY_INFORMATION</c>, where the label physically lives — needs no privilege.
    ///
    /// <para>Its failure is what decides whether confinement is applied at all: a child confined to a
    /// directory it cannot write would fail for a reason that has nothing to do with the model, which
    /// the contract forbids more strongly than it asks for confinement. So the caller degrades instead.</para>
    /// </summary>
    public static bool TryLabelRunDirectory(string runDirectory, out string? failure)
    {
        failure = null;
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    LowLabelSddl, SddlRevision1, out descriptor, out uint _))
            {
                failure = Reason("the low mandatory label could not be built");
                return false;
            }

            if (!GetSecurityDescriptorSacl(descriptor, out bool present, out IntPtr sacl, out bool _)
                || !present)
            {
                failure = Reason("the low mandatory label carried no ACL");
                return false;
            }

            uint result = SetNamedSecurityInfoW(
                runDirectory, SeFileObject, LabelSecurityInformation,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (result != 0)
            {
                failure = "the run directory could not be labelled low integrity (error "
                    + result.ToString(CultureInfo.InvariantCulture) + ")";
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            failure = "the run directory could not be labelled low integrity (" + ex.Message + ")";
            return false;
        }
        finally
        {
            if (descriptor != IntPtr.Zero)
            {
                LocalFree(descriptor);
            }
        }
    }

    /// <summary>
    /// A primary token duplicated from the caller's own and relabelled low integrity, or <c>null</c> with
    /// the reason. Needs no privilege and no elevation: lowering your own token's integrity and creating
    /// a process with it is a de-escalation, which is why <c>CreateProcessAsUser</c> accepts it without
    /// <c>SE_ASSIGNPRIMARYTOKEN_NAME</c>.
    /// </summary>
    private static SafeAccessTokenHandle? TryCreateToken(out string? failure)
    {
        failure = null;
        IntPtr duplicate = IntPtr.Zero;
        IntPtr lowIntegrity = IntPtr.Zero;
        IntPtr label = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(
                    GetCurrentProcess(),
                    TokenDuplicate | TokenQuery | TokenAssignPrimary | TokenAdjustDefault | TokenAdjustSessionId,
                    out IntPtr self))
            {
                failure = Reason("this process's own token could not be opened");
                return null;
            }

            try
            {
                if (!DuplicateTokenEx(self, MaximumAllowed, IntPtr.Zero,
                        SecurityImpersonationLevel, PrimaryTokenType, out duplicate))
                {
                    failure = Reason("a primary token could not be duplicated");
                    return null;
                }
            }
            finally
            {
                CloseHandle(self);
            }

            if (!ConvertStringSidToSidW(LowIntegritySid, out lowIntegrity))
            {
                failure = Reason("the low-integrity SID could not be built");
                return null;
            }

            var mandatory = new TokenMandatoryLabelStruct
            {
                Label = new SidAndAttributesStruct { Sid = lowIntegrity, Attributes = SeGroupIntegrity },
            };
            int size = Marshal.SizeOf<TokenMandatoryLabelStruct>();
            label = Marshal.AllocHGlobal(size);
            Marshal.StructureToPtr(mandatory, label, fDeleteOld: false);

            if (!SetTokenInformation(
                    duplicate, TokenIntegrityLevel, label, (uint)(size + GetLengthSid(lowIntegrity))))
            {
                failure = Reason("the token could not be relabelled low integrity");
                return null;
            }

            var handle = new SafeAccessTokenHandle(duplicate);
            duplicate = IntPtr.Zero;
            return handle;
        }
        catch (Exception ex)
        {
            failure = "a low-integrity token could not be derived (" + ex.Message + ")";
            return null;
        }
        finally
        {
            if (label != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(label);
            }

            if (lowIntegrity != IntPtr.Zero)
            {
                LocalFree(lowIntegrity);
            }

            if (duplicate != IntPtr.Zero)
            {
                CloseHandle(duplicate);
            }
        }
    }

    private static WindowsConfinedProcess? TryStart(
        SafeAccessTokenHandle token, ProcessStartInfo startInfo, out string? failure)
    {
        failure = null;
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        var information = default(ProcessInformationStruct);
        SafeProcessHandle? thread = null;
        bool created = false;

        try
        {
            var inheritable = new SecurityAttributesStruct
            {
                Length = Marshal.SizeOf<SecurityAttributesStruct>(),
                SecurityDescriptor = IntPtr.Zero,
                InheritHandle = 1,
            };

            if (!CreatePipe(out inputRead, out inputWrite, ref inheritable, 0)
                || !CreatePipe(out outputRead, out outputWrite, ref inheritable, 0)
                || !CreatePipe(out errorRead, out errorWrite, ref inheritable, 0))
            {
                failure = Reason("the child's pipes could not be created");
                return null;
            }

            // The HOST's end of each pipe must NOT be inheritable, or the child holds the far end open
            // and the host's ReadToEnd never completes — the classic hand-plumbed-stdio deadlock.
            if (!SetHandleInformation(inputWrite, HandleFlagInherit, 0)
                || !SetHandleInformation(outputRead, HandleFlagInherit, 0)
                || !SetHandleInformation(errorRead, HandleFlagInherit, 0))
            {
                failure = Reason("the host's pipe ends could not be made non-inheritable");
                return null;
            }

            var startup = default(StartupInfoStruct);
            startup.Cb = Marshal.SizeOf<StartupInfoStruct>();
            startup.Flags = StartFUseStdHandles;
            startup.StdInput = inputRead;
            startup.StdOutput = outputWrite;
            startup.StdError = errorWrite;

            environment = BuildEnvironment(startInfo);
            var commandLine = new StringBuilder(BuildCommandLine(startInfo));
            string? workingDirectory = string.IsNullOrEmpty(startInfo.WorkingDirectory)
                ? null
                : startInfo.WorkingDirectory;

            if (!CreateProcessAsUserW(
                    token, null, commandLine, IntPtr.Zero, IntPtr.Zero, inheritHandles: true,
                    CreateSuspended | CreateNoWindow | CreateUnicodeEnvironment,
                    environment, workingDirectory, ref startup, out information))
            {
                failure = Reason("the confined child could not be created");
                return null;
            }

            created = true;

            // The CHILD's ends, closed in the host the moment they have been inherited. Keeping them
            // would withhold the EOF the host's readers wait for.
            CloseHandle(inputRead);
            inputRead = IntPtr.Zero;
            CloseHandle(outputWrite);
            outputWrite = IntPtr.Zero;
            CloseHandle(errorWrite);
            errorWrite = IntPtr.Zero;

            // Safe precisely because the child is suspended: it cannot have exited, so the id still
            // names it and no other process can have inherited the number.
            Process process = Process.GetProcessById(information.ProcessId);

            // Force the Process to OPEN AND HOLD its own handle, now, while the child is still suspended.
            // A Process it did not start keeps only an id, and Process.ExitCode throws outright
            // ("Process was not started by this object") unless a handle was held — WaitForExit opens a
            // transient SYNCHRONIZE-only one, which does not count. Reading .Handle is what makes the
            // exit code, and therefore every diagnosis the host draws from it, readable at all.
            _ = process.Handle;
            thread = new SafeProcessHandle(information.Thread, ownsHandle: true);
            information.Thread = IntPtr.Zero;

            Encoding input = startInfo.StandardInputEncoding ?? Utf8;
            Encoding output = startInfo.StandardOutputEncoding ?? Utf8;
            Encoding error = startInfo.StandardErrorEncoding ?? Utf8;

            var standardInput = new StreamWriter(
                new FileStream(new SafeFileHandle(inputWrite, ownsHandle: true), FileAccess.Write), input)
            {
                AutoFlush = true,
            };
            inputWrite = IntPtr.Zero;

            var standardOutput = new StreamReader(
                new FileStream(new SafeFileHandle(outputRead, ownsHandle: true), FileAccess.Read), output);
            outputRead = IntPtr.Zero;

            var standardError = new StreamReader(
                new FileStream(new SafeFileHandle(errorRead, ownsHandle: true), FileAccess.Read), error);
            errorRead = IntPtr.Zero;

            created = false; // ownership has passed to the object below
            return new WindowsConfinedProcess(process, thread, standardInput, standardOutput, standardError);
        }
        catch (Exception ex)
        {
            failure = "the confined child could not be started (" + ex.Message + ")";
            return null;
        }
        finally
        {
            // A child created but not handed back would sit SUSPENDED forever — nobody left to resume it,
            // and no deadline watching it, because the caller is about to take the fallback path instead.
            if (created)
            {
                TerminateProcess(information.Process, 1);
                thread?.Dispose();
            }

            foreach (IntPtr handle in (IntPtr[])
                     [inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite,
                      information.Process, information.Thread])
            {
                if (handle != IntPtr.Zero)
                {
                    CloseHandle(handle);
                }
            }

            if (environment != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(environment);
            }
        }
    }

    /// <summary>
    /// Runs a no-op command under a freshly derived token and reports whether it exited 0 — the same
    /// "would this mechanism have run the scenario?" question every other probe asks, and deliberately
    /// asked through the WHOLE path (token, pipes, suspended create, resume) rather than a cheaper
    /// approximation of it.
    /// </summary>
    private static bool Probe()
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("COMSPEC")
                           ?? Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                WorkingDirectory = Path.GetTempPath(),
            };
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add("exit 0");

            using WindowsConfinedProcess? probe = TryStart(startInfo, out string? startFailure);
            if (probe is null)
            {
                _probeFailure = startFailure;
                return false;
            }

            probe.Resume();

            // Drain both pipes so a probe that prints something cannot wedge on a full buffer, and close
            // stdin so nothing can sit waiting for input nobody will send.
            probe.StandardInput.Close();
            Task<string> output = probe.StandardOutput.ReadToEndAsync();
            Task<string> error = probe.StandardError.ReadToEndAsync();

            if (!probe.Process.WaitForExit((int)ProbeTimeout.TotalMilliseconds))
            {
                try
                {
                    probe.Process.Kill(entireProcessTree: true);
                }
                catch (Exception)
                {
                    // Already gone; nothing to stop.
                }

                _probeFailure = "a trivial command did not finish under the confined token";
                return false;
            }

            try
            {
                Task.WaitAll([output, error], ProbeTimeout);
            }
            catch (Exception)
            {
                // A faulted read says nothing about the exit code, which is what the probe asks about.
            }

            if (probe.Process.ExitCode == 0)
            {
                return true;
            }

            _probeFailure = "a trivial command exited "
                + probe.Process.ExitCode.ToString(CultureInfo.InvariantCulture)
                + " under the confined token";
            return false;
        }
        catch (Exception ex)
        {
            _probeFailure = "the confined-launch probe failed (" + ex.Message + ")";
            return false;
        }
    }

    /// <summary>The child's environment block: <c>NAME=VALUE\0…\0\0</c>, sorted the way Windows expects.
    /// Built from <paramref name="startInfo"/> rather than inherited, because the host has already
    /// SCRUBBED that dictionary — passing <c>null</c> here would hand the child the host's own
    /// environment and silently undo the scrub.</summary>
    private static IntPtr BuildEnvironment(ProcessStartInfo startInfo)
    {
        var block = new StringBuilder();
        foreach (var (name, value) in startInfo.Environment
                     .Where(entry => entry.Value is not null)
                     .OrderBy(entry => entry.Key, StringComparer.OrdinalIgnoreCase))
        {
            block.Append(name).Append('=').Append(value).Append('\0');
        }

        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    /// <summary>The command line <c>CreateProcessAsUser</c> takes instead of an argument list, quoted the
    /// way the C runtime's parser (and therefore .NET's own <c>ArgumentList</c>) reads it back.</summary>
    private static string BuildCommandLine(ProcessStartInfo startInfo)
    {
        var line = new StringBuilder(Quote(startInfo.FileName));
        foreach (string argument in startInfo.ArgumentList)
        {
            line.Append(' ').Append(Quote(argument));
        }

        return line.ToString();
    }

    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0)
        {
            return argument;
        }

        var quoted = new StringBuilder("\"");
        for (int index = 0; index < argument.Length; index++)
        {
            int backslashes = 0;
            while (index < argument.Length && argument[index] == '\\')
            {
                backslashes++;
                index++;
            }

            if (index == argument.Length)
            {
                // Trailing backslashes are doubled so the closing quote is not escaped by them.
                quoted.Append('\\', backslashes * 2);
                break;
            }

            if (argument[index] == '"')
            {
                quoted.Append('\\', (backslashes * 2) + 1).Append('"');
            }
            else
            {
                quoted.Append('\\', backslashes).Append(argument[index]);
            }
        }

        return quoted.Append('"').ToString();
    }

    private static string Reason(string what) =>
        what + " (error "
        + Marshal.GetLastPInvokeError().ToString(CultureInfo.InvariantCulture) + ")";

    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    // ------------------------------------------------------------------------
    // Native surface. Field order and widths ARE the ABI.
    // ------------------------------------------------------------------------

    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint TokenAdjustSessionId = 0x0100;
    private const uint MaximumAllowed = 0x02000000;
    private const int SecurityImpersonationLevel = 2;
    private const int PrimaryTokenType = 1;
    private const int TokenIntegrityLevel = 25;
    private const uint SeGroupIntegrity = 0x00000020;

    /// <summary><c>SECURITY_MANDATORY_LOW_RID</c> in SDDL form — the label that denies the child write
    /// access to every object the user owns, and nothing else.</summary>
    private const string LowIntegritySid = "S-1-16-4096";

    /// <summary>A security descriptor whose SACL is a single low mandatory label ACE: object- and
    /// container-inheritable (<c>OICI</c>), no-write-up (<c>NW</c>), low level (<c>LW</c>).</summary>
    private const string LowLabelSddl = "S:(ML;OICI;NW;;;LW)";

    private const uint SddlRevision1 = 1;
    private const int SeFileObject = 1;
    private const uint LabelSecurityInformation = 0x00000010;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const int StartFUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;

    // DllImport rather than LibraryImport, matching WindowsJobObject: the source generator emits
    // `unsafe` code, and this assembly deliberately does not set AllowUnsafeBlocks.
#pragma warning disable SYSLIB1054
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributesStruct attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(SafeProcessHandle thread);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        IntPtr existing, uint desiredAccess, IntPtr attributes, int impersonationLevel, int tokenType,
        out IntPtr duplicate);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSidToSidW(string sid, out IntPtr binarySid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetLengthSid(IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetTokenInformation(
        IntPtr token, int informationClass, IntPtr information, uint length);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string sddl, uint revision, out IntPtr descriptor, out uint size);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSecurityDescriptorSacl(
        IntPtr descriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool present,
        out IntPtr sacl,
        [MarshalAs(UnmanagedType.Bool)] out bool defaulted);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetNamedSecurityInfoW(
        string objectName, int objectType, uint securityInformation,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUserW(
        SafeAccessTokenHandle token, string? applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
        IntPtr environment, string? currentDirectory,
        ref StartupInfoStruct startupInfo, out ProcessInformationStruct information);
#pragma warning restore SYSLIB1054

    /// <summary>Mirrors <c>SECURITY_ATTRIBUTES</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributesStruct
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public int InheritHandle;
    }

    /// <summary>Mirrors <c>SID_AND_ATTRIBUTES</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributesStruct
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    /// <summary>Mirrors <c>TOKEN_MANDATORY_LABEL</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenMandatoryLabelStruct
    {
        public SidAndAttributesStruct Label;
    }

    /// <summary>Mirrors <c>STARTUPINFOW</c>.</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfoStruct
    {
        public int Cb;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2Length;
        public IntPtr Reserved2;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    /// <summary>Mirrors <c>PROCESS_INFORMATION</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformationStruct
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }
}
