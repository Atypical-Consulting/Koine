using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace Koine.Compiler.Tests;

/// <summary>
/// TEMPORARY — issue #1780, Task 1. The spike that decides which Windows mechanism the scenario child's
/// filesystem and network confinement is built on: a restricted + low-integrity token, or an
/// AppContainer. It answers the three questions the issue's plan poses, on a real kernel rather than
/// from the documentation, and is DELETED by Task 2 once its findings are recorded in the PR.
///
/// <para>It reports through <c>Assert.Fail</c> on purpose: the only Windows kernel this change can reach
/// is the <c>sandbox-confinement</c> job's <c>windows-latest</c> leg (#1782), and a failure message is
/// the one channel whose text is guaranteed to reach the CI log. A red draft run IS the instrument.</para>
///
/// <para>Named to match the job's <c>FullyQualifiedName~ScenarioSandboxTests</c> filter.</para>
/// </summary>
[Collection(ScenarioSandboxCollection.Name)]
public sealed class ScenarioSandboxTestsWindowsSpike
{
    [Fact]
    public void Spike_which_Windows_mechanism_can_confine_the_scenario_child()
    {
        if (!OperatingSystem.IsWindows())
        {
            Assert.Skip("The spike probes Windows kernel mechanisms; running on "
                + RuntimeInformation.OSDescription + ".");
            return;
        }

        var report = new StringBuilder();
        report.Append("\n===== #1780 Task 1 spike: Windows confinement mechanisms =====\n");
        report.Append("OS: ").Append(RuntimeInformation.OSDescription).Append('\n');
        report.Append("Session: ").Append(Environment.UserName).Append('\n');

        string runDirectory = Path.Combine(Path.GetTempPath(), "koine-spike-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(runDirectory);
        string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string outside = Path.Combine(userProfile, "koine-spike-outside.txt");
        string inside = Path.Combine(runDirectory, "inside.txt");
        string comspec = Environment.GetEnvironmentVariable("COMSPEC") ?? @"C:\Windows\System32\cmd.exe";
        string curl = Path.Combine(Environment.SystemDirectory, "curl.exe");
        string? dotnet = LocateDotnet();
        string binaries = Path.GetDirectoryName(typeof(ScenarioSandboxTestsWindowsSpike).Assembly.Location)
            ?? AppContext.BaseDirectory;

        report.Append("comspec: ").Append(comspec).Append('\n');
        report.Append("curl.exe present: ").Append(File.Exists(curl)).Append('\n');
        report.Append("dotnet: ").Append(dotnet ?? "<not found>").Append('\n');
        report.Append("test binaries: ").Append(binaries).Append('\n');
        report.Append("run directory: ").Append(runDirectory).Append('\n');

        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        report.Append("loopback listener port: ").Append(port.ToString(CultureInfo.InvariantCulture)).Append('\n');

        try
        {
            report.Append("\n--- 0. Baseline (caller's own token, no confinement) ---\n");
            Probe(report, "baseline write outside", IntPtr.Zero, Quote(comspec) + " /c echo x > " + Quote(outside), null);
            Probe(report, "baseline write inside", IntPtr.Zero, Quote(comspec) + " /c echo x > " + Quote(inside), null);
            Probe(report, "baseline loopback", IntPtr.Zero, NetCommand(curl, port), null);
            Forget(outside);
            Forget(inside);

            report.Append("\n--- A. Low-integrity token ---\n");
            SpikeLowIntegrity(report, runDirectory, outside, inside, comspec, curl, dotnet, binaries, port);

            report.Append("\n--- B. AppContainer, no capabilities ---\n");
            SpikeAppContainer(report, runDirectory, outside, inside, comspec, curl, dotnet, binaries, port);
        }
        catch (Exception ex)
        {
            report.Append("\nSPIKE THREW: ").Append(ex).Append('\n');
        }
        finally
        {
            listener.Stop();
            Forget(outside);
            try
            {
                Directory.Delete(runDirectory, recursive: true);
            }
            catch (Exception)
            {
                // A leftover temp directory is not a finding.
            }
        }

        report.Append("\n===== end of spike =====\n");
        Assert.Fail(report.ToString());
    }

    // ------------------------------------------------------------------------
    // Variant A — a primary token duplicated from the caller's, relabelled low integrity.
    // ------------------------------------------------------------------------

    private static void SpikeLowIntegrity(
        StringBuilder report,
        string runDirectory,
        string outside,
        string inside,
        string comspec,
        string curl,
        string? dotnet,
        string binaries,
        int port)
    {
        IntPtr token = IntPtr.Zero;
        IntPtr lowSid = IntPtr.Zero;
        IntPtr label = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenDuplicate | TokenQuery | TokenAssignPrimary
                    | TokenAdjustDefault | TokenAdjustSessionId, out IntPtr self))
            {
                report.Append("OpenProcessToken FAILED, error ").Append(LastError()).Append('\n');
                return;
            }

            try
            {
                if (!DuplicateTokenEx(self, MaximumAllowed, IntPtr.Zero,
                        SecurityImpersonationLevel, PrimaryTokenType, out token))
                {
                    report.Append("DuplicateTokenEx FAILED, error ").Append(LastError()).Append('\n');
                    return;
                }
            }
            finally
            {
                CloseHandle(self);
            }

            if (!ConvertStringSidToSidW(LowIntegritySid, out lowSid))
            {
                report.Append("ConvertStringSidToSid FAILED, error ").Append(LastError()).Append('\n');
                return;
            }

            var mandatory = new TokenMandatoryLabelStruct
            {
                Label = new SidAndAttributesStruct { Sid = lowSid, Attributes = SeGroupIntegrity },
            };
            int size = Marshal.SizeOf<TokenMandatoryLabelStruct>();
            label = Marshal.AllocHGlobal(size);
            Marshal.StructureToPtr(mandatory, label, fDeleteOld: false);

            if (!SetTokenInformation(token, TokenIntegrityLevel, label, (uint)(size + GetLengthSid(lowSid))))
            {
                report.Append("SetTokenInformation(TokenIntegrityLevel) FAILED, error ")
                    .Append(LastError()).Append('\n');
                return;
            }

            report.Append("token derived OK (duplicated primary token relabelled S-1-16-4096)\n");

            Probe(report, "A: cmd.exe /c exit 42", token, Quote(comspec) + " /c exit 42", null);
            Probe(report, "A: write outside (want NON-zero)", token,
                Quote(comspec) + " /c echo x > " + Quote(outside), null);
            report.Append("     outside file exists: ").Append(File.Exists(outside)).Append('\n');
            Probe(report, "A: write inside UNLABELLED run dir", token,
                Quote(comspec) + " /c echo x > " + Quote(inside), runDirectory);
            report.Append("     inside file exists: ").Append(File.Exists(inside)).Append('\n');

            report.Append("label run dir low: ").Append(TryLabelLow(runDirectory, out string? labelFailure)).Append(' ')
                .Append(labelFailure ?? string.Empty).Append('\n');
            Forget(inside);
            Probe(report, "A: write inside LABELLED run dir (want 0)", token,
                Quote(comspec) + " /c echo x > " + Quote(inside), runDirectory);
            report.Append("     inside file exists: ").Append(File.Exists(inside)).Append('\n');

            Probe(report, "A: loopback connect (7 == denied)", token, NetCommand(curl, port), runDirectory);
            Probe(report, "A: read a test binary", token,
                Quote(comspec) + " /c type " + Quote(Path.Combine(binaries, "Koine.Execution.dll")) + " > NUL", runDirectory);
            if (dotnet is not null)
            {
                Probe(report, "A: dotnet --version (want 0)", token, Quote(dotnet) + " --version", runDirectory);
            }
        }
        finally
        {
            Forget(outside);
            if (label != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(label);
            }

            if (lowSid != IntPtr.Zero)
            {
                LocalFree(lowSid);
            }

            if (token != IntPtr.Zero)
            {
                CloseHandle(token);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Variant B — an AppContainer with no capabilities at all.
    // ------------------------------------------------------------------------

    private static void SpikeAppContainer(
        StringBuilder report,
        string runDirectory,
        string outside,
        string inside,
        string comspec,
        string curl,
        string? dotnet,
        string binaries,
        int port)
    {
        string container = "koine-spike-" + Guid.NewGuid().ToString("N");
        IntPtr containerSid = IntPtr.Zero;
        try
        {
            int created = CreateAppContainerProfile(
                container, container, "Koine #1780 spike", IntPtr.Zero, 0, out containerSid);
            report.Append("CreateAppContainerProfile hresult 0x")
                .Append(created.ToString("X8", CultureInfo.InvariantCulture)).Append('\n');
            if (created < 0)
            {
                return;
            }

            Forget(inside);
            ProbeAppContainer(report, containerSid, "B: cmd.exe /c exit 42",
                Quote(comspec) + " /c exit 42", null);
            ProbeAppContainer(report, containerSid, "B: write outside (want NON-zero)",
                Quote(comspec) + " /c echo x > " + Quote(outside), null);
            report.Append("     outside file exists: ").Append(File.Exists(outside)).Append('\n');
            ProbeAppContainer(report, containerSid, "B: write inside run dir",
                Quote(comspec) + " /c echo x > " + Quote(inside), runDirectory);
            report.Append("     inside file exists: ").Append(File.Exists(inside)).Append('\n');
            ProbeAppContainer(report, containerSid, "B: loopback connect (7 == denied)",
                NetCommand(curl, port), runDirectory);
            ProbeAppContainer(report, containerSid, "B: read a test binary",
                Quote(comspec) + " /c type " + Quote(Path.Combine(binaries, "Koine.Execution.dll")) + " > NUL",
                runDirectory);
            if (dotnet is not null)
            {
                ProbeAppContainer(report, containerSid, "B: dotnet --version", Quote(dotnet) + " --version", runDirectory);
            }
        }
        finally
        {
            Forget(outside);
            if (containerSid != IntPtr.Zero)
            {
                FreeSid(containerSid);
            }

            DeleteAppContainerProfile(container);
        }
    }

    // ------------------------------------------------------------------------
    // Probe plumbing.
    // ------------------------------------------------------------------------

    /// <summary>Runs <paramref name="commandLine"/> under <paramref name="token"/> (or the caller's own
    /// token when <see cref="IntPtr.Zero"/>) and appends its exit code — or the creation error.</summary>
    private static void Probe(
        StringBuilder report, string what, IntPtr token, string commandLine, string? workingDirectory)
    {
        var startup = default(StartupInfoStruct);
        startup.Cb = Marshal.SizeOf<StartupInfoStruct>();

        bool started = token == IntPtr.Zero
            ? CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
                CreateNoWindow | CreateUnicodeEnvironment, IntPtr.Zero, workingDirectory,
                ref startup, out ProcessInformationStruct information)
            : CreateProcessAsUserW(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
                false, CreateNoWindow | CreateUnicodeEnvironment, IntPtr.Zero, workingDirectory,
                ref startup, out information);

        Finish(report, what, started, information);
    }

    private static void ProbeAppContainer(
        StringBuilder report, IntPtr containerSid, string what, string commandLine, string? workingDirectory)
    {
        IntPtr attributes = IntPtr.Zero;
        IntPtr capabilities = IntPtr.Zero;
        try
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
            {
                report.Append(what).Append(": InitializeProcThreadAttributeList FAILED, error ")
                    .Append(LastError()).Append('\n');
                return;
            }

            var security = new SecurityCapabilitiesStruct
            {
                AppContainerSid = containerSid,
                Capabilities = IntPtr.Zero,
                CapabilityCount = 0,
                Reserved = 0,
            };
            int securitySize = Marshal.SizeOf<SecurityCapabilitiesStruct>();
            capabilities = Marshal.AllocHGlobal(securitySize);
            Marshal.StructureToPtr(security, capabilities, fDeleteOld: false);

            if (!UpdateProcThreadAttribute(attributes, 0, SecurityCapabilitiesAttribute, capabilities,
                    (IntPtr)securitySize, IntPtr.Zero, IntPtr.Zero))
            {
                report.Append(what).Append(": UpdateProcThreadAttribute FAILED, error ")
                    .Append(LastError()).Append('\n');
                return;
            }

            var extended = default(StartupInfoExStruct);
            extended.StartupInfo.Cb = Marshal.SizeOf<StartupInfoExStruct>();
            extended.AttributeList = attributes;

            bool started = CreateProcessAsUserExW(IntPtr.Zero, null, new StringBuilder(commandLine),
                IntPtr.Zero, IntPtr.Zero, false,
                CreateNoWindow | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
                IntPtr.Zero, workingDirectory, ref extended, out ProcessInformationStruct information);

            Finish(report, what, started, information);
        }
        finally
        {
            if (attributes != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }

            if (capabilities != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(capabilities);
            }
        }
    }

    private static void Finish(
        StringBuilder report, string what, bool started, ProcessInformationStruct information)
    {
        if (!started)
        {
            report.Append("  ").Append(what).Append(": CREATE FAILED, error ").Append(LastError()).Append('\n');
            return;
        }

        WaitForSingleObject(information.Process, 15000);
        GetExitCodeProcess(information.Process, out uint exitCode);
        CloseHandle(information.Thread);
        CloseHandle(information.Process);
        report.Append("  ").Append(what).Append(": exit ")
            .Append(exitCode.ToString(CultureInfo.InvariantCulture)).Append('\n');
    }

    /// <summary>Sets a low mandatory label on <paramref name="directory"/>, so a low-integrity child keeps
    /// its scratch space. The label sits in the SACL but is written through LABEL_SECURITY_INFORMATION,
    /// which — unlike SACL_SECURITY_INFORMATION — needs no privilege.</summary>
    private static bool TryLabelLow(string directory, out string? failure)
    {
        failure = null;
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    LowLabelSddl, SddlRevision1, out descriptor, out uint _))
            {
                failure = "ConvertStringSecurityDescriptor error " + LastError();
                return false;
            }

            if (!GetSecurityDescriptorSacl(descriptor, out bool present, out IntPtr sacl, out bool _) || !present)
            {
                failure = "GetSecurityDescriptorSacl error " + LastError();
                return false;
            }

            uint result = SetNamedSecurityInfoW(
                directory, SeFileObject, LabelSecurityInformation,
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
            if (result != 0)
            {
                failure = "SetNamedSecurityInfo error " + result.ToString(CultureInfo.InvariantCulture);
                return false;
            }

            return true;
        }
        finally
        {
            if (descriptor != IntPtr.Zero)
            {
                LocalFree(descriptor);
            }
        }
    }

    private static string NetCommand(string curl, int port) =>
        Quote(curl) + " -s -o NUL --max-time 4 http://127.0.0.1:"
        + port.ToString(CultureInfo.InvariantCulture) + "/";

    private static string Quote(string path) => "\"" + path + "\"";

    private static string LastError() =>
        Marshal.GetLastPInvokeError().ToString(CultureInfo.InvariantCulture);

    private static void Forget(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception)
        {
            // A leftover temp file is not a finding.
        }
    }

    private static string? LocateDotnet()
    {
        if (Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } root
            && File.Exists(Path.Combine(root, "dotnet.exe")))
        {
            return Path.Combine(root, "dotnet.exe");
        }

        foreach (string candidate in (string[])[@"C:\Program Files\dotnet\dotnet.exe"])
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    // ------------------------------------------------------------------------
    // Native surface.
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
    private const string LowIntegritySid = "S-1-16-4096";
    private const string LowLabelSddl = "S:(ML;OICI;NW;;;LW)";
    private const uint SddlRevision1 = 1;
    private const int SeFileObject = 1;
    private const uint LabelSecurityInformation = 0x00000010;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private static readonly IntPtr SecurityCapabilitiesAttribute = (IntPtr)0x00020009;

#pragma warning disable SYSLIB1054 // DllImport, matching WindowsJobObject: LibraryImport emits `unsafe`.
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        IntPtr existing, uint desiredAccess, IntPtr attributes, int impersonationLevel, int tokenType,
        out IntPtr duplicate);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "ConvertStringSidToSidW")]
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string? applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment,
        string? currentDirectory, ref StartupInfoStruct startupInfo, out ProcessInformationStruct information);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessAsUserW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUserW(
        IntPtr token, string? applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
        IntPtr environment, string? currentDirectory,
        ref StartupInfoStruct startupInfo, out ProcessInformationStruct information);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessAsUserW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUserExW(
        IntPtr token, string? applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags,
        IntPtr environment, string? currentDirectory,
        ref StartupInfoExStruct startupInfo, out ProcessInformationStruct information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr list, int attributeCount, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
        IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string name, string displayName, string description,
        IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string name);

    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);
#pragma warning restore SYSLIB1054

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributesStruct
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenMandatoryLabelStruct
    {
        public SidAndAttributesStruct Label;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilitiesStruct
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

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

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoExStruct
    {
        public StartupInfoStruct StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformationStruct
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }
}
