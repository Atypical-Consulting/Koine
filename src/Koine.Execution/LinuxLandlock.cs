using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Koine.Execution;

/// <summary>
/// Linux's unprivileged filesystem confinement (issue #1781): a Landlock ruleset that leaves READS open
/// everywhere and permits WRITES only beneath one directory — the same shape as the macOS
/// <c>sandbox-exec</c> profile ADR 0012 already ships.
///
/// <para><b>Why this class exists at all.</b> ADR 0012 recorded Landlock as unreachable because
/// <c>landlock_restrict_self(2)</c> must be called by the process being confined, between fork and exec,
/// and .NET offers no pre-exec hook. The escape hatch is ADR 0012's own chosen shape — apply confinement
/// by BECOMING it: <see cref="Koine"/>'s hidden launcher verb installs this ruleset on itself and then
/// <c>execv</c>s the real command. A ruleset is inherited across <c>execve</c> and can never be relaxed,
/// so the "no pre-exec hook" problem dissolves into a process boundary this repo already owns.</para>
///
/// <para><b>Nothing here throws and nothing here fails a run.</b> Every entry point returns a message
/// instead, because a scenario must still execute on a kernel that cannot confine it — with an honest
/// note saying so (issue #1759). The one thing this class must never do is report success it did not
/// achieve.</para>
/// </summary>
[SupportedOSPlatform("linux")]
internal static class LinuxLandlock
{
    // x86-64 and arm64 share these numbers (asm-generic). Any other architecture is left unsupported
    // rather than guessed at — see AbiVersion.
    private const long CreateRulesetSyscall = 444;
    private const long AddRuleSyscall = 445;
    private const long RestrictSelfSyscall = 446;

    /// <summary><c>LANDLOCK_CREATE_RULESET_VERSION</c> — asks the kernel which ABI it speaks instead of
    /// creating anything.</summary>
    private const uint CreateRulesetVersion = 1;

    /// <summary><c>LANDLOCK_RULE_PATH_BENEATH</c>, the only rule type ABI v1 defines.</summary>
    private const int RulePathBeneath = 1;

    // LANDLOCK_ACCESS_FS_*, in ABI order. The bits above WriteFile are what a write confinement is
    // actually made of: creating, removing and renaming are all writes to a DIRECTORY.
    private const ulong AccessExecute = 1UL << 0;
    private const ulong AccessWriteFile = 1UL << 1;
    private const ulong AccessReadFile = 1UL << 2;
    private const ulong AccessReadDirectory = 1UL << 3;
    private const ulong AccessRemoveDirectory = 1UL << 4;
    private const ulong AccessRemoveFile = 1UL << 5;
    private const ulong AccessMakeCharacter = 1UL << 6;
    private const ulong AccessMakeDirectory = 1UL << 7;
    private const ulong AccessMakeRegular = 1UL << 8;
    private const ulong AccessMakeSocket = 1UL << 9;
    private const ulong AccessMakeFifo = 1UL << 10;
    private const ulong AccessMakeBlock = 1UL << 11;
    private const ulong AccessMakeSymbolic = 1UL << 12;

    /// <summary><c>LANDLOCK_ACCESS_FS_REFER</c> (ABI v2). Handling it is what makes a rename or a hard link
    /// BETWEEN two directories expressible at all: when it is not handled, the kernel denies every such
    /// operation outright, which would break a legitimate rename inside the run directory itself.</summary>
    private const ulong AccessRefer = 1UL << 13;

    /// <summary><c>LANDLOCK_ACCESS_FS_TRUNCATE</c> (ABI v3). Truncation is a write that predates the write
    /// bits, so a ruleset that does not handle it leaves <c>ftruncate</c> on an outside file open.</summary>
    private const ulong AccessTruncate = 1UL << 14;

    /// <summary>Everything a process may do to a file it merely READS or RUNS. Granted beneath <c>/</c>:
    /// ADR 0012's standing decision is that reads stay open, because the child must load the .NET runtime,
    /// the shared framework and its own assemblies, none of which live in the run directory.</summary>
    private const ulong ReadOnlyAccess = AccessExecute | AccessReadFile | AccessReadDirectory;

    /// <summary>The character devices a process legitimately writes to without touching the filesystem —
    /// the same allowance the macOS profile makes. Proven necessary, not assumed: without it a plain
    /// <c>2&gt;/dev/null</c> in the confined child fails with <c>Permission denied</c>.</summary>
    private static readonly string[] WritableDevices =
        ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"];

    private static readonly Lazy<int> Abi = new(ProbeAbiVersion);

    /// <summary>
    /// The Landlock ABI this kernel speaks, or <c>-1</c> when it speaks none — Landlock compiled out,
    /// disabled through <c>lsm=</c>, a kernel older than 5.13, or an architecture whose syscall numbers
    /// are not the two this class knows. Settled once per process; never throws.
    /// </summary>
    internal static int AbiVersion => Abi.Value;

    private static int ProbeAbiVersion()
    {
        if (!OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            return -1;
        }

        try
        {
            LinuxNative.EnsureLibcResolver();

            // A NULL attribute with the VERSION flag asks the kernel what it supports and builds nothing.
            long version = SyscallVersion(CreateRulesetSyscall, IntPtr.Zero, 0, CreateRulesetVersion);
            return version > 0 ? (int)version : -1;
        }
        catch (Exception)
        {
            // No libc, no such syscall, a refused P/Invoke — all the same answer: this kernel cannot.
            return -1;
        }
    }

    /// <summary>
    /// Confines THIS process's writes to <paramref name="writableDirectory"/> (and the character devices
    /// above) for the rest of its life, including across every <c>execve</c> it goes on to make. Reads and
    /// executions stay unrestricted.
    ///
    /// <para>Returns <c>true</c> only when the kernel actually installed the ruleset. On <c>false</c>,
    /// <paramref name="failure"/> says why — and the caller must treat the process as UNCONFINED, never
    /// assume the restriction landed.</para>
    /// </summary>
    internal static bool TryRestrict(string writableDirectory, out string? failure)
    {
        int abi = AbiVersion;
        if (abi < 1)
        {
            failure = "this kernel does not offer Landlock (no ABI version)";
            return false;
        }

        int ruleset = -1;
        try
        {
            ulong handled = HandledAccess(abi);
            var attribute = new RulesetAttribute { HandledAccessFilesystem = handled };

            // Deliberately sizeof(ulong) and not sizeof(RulesetAttribute): the kernel accepts any size
            // from the end of handled_access_fs upward, and sending only the field this ruleset uses keeps
            // one struct valid on every ABI from v1 to today.
            long created = SyscallCreate(CreateRulesetSyscall, ref attribute, sizeof(ulong), 0);
            if (created < 0)
            {
                failure = "the Landlock ruleset could not be created: " + LinuxNative.LastError();
                return false;
            }

            ruleset = (int)created;

            if (!Allow(ruleset, "/", ReadOnlyAccess, out failure)
                || !Allow(ruleset, writableDirectory, handled, out failure))
            {
                return false;
            }

            foreach (string device in WritableDevices)
            {
                // A device this host does not have is not a failure — it is a device the child cannot
                // write to either way.
                _ = Allow(ruleset, device, AccessReadFile | AccessWriteFile, out _);
            }

            if (LinuxNative.SetNoNewPrivileges() != 0)
            {
                failure = "no_new_privs could not be set, which Landlock requires: " + LinuxNative.LastError();
                return false;
            }

            if (SyscallRestrictSelf(RestrictSelfSyscall, ruleset, 0) != 0)
            {
                failure = "the Landlock ruleset could not be enforced: " + LinuxNative.LastError();
                return false;
            }

            failure = null;
            return true;
        }
        catch (Exception ex)
        {
            failure = "the Landlock ruleset could not be built: " + ex.Message;
            return false;
        }
        finally
        {
            LinuxNative.Close(ruleset);
        }
    }

    /// <summary>
    /// What this ruleset takes responsibility for. An access right the ruleset does not HANDLE stays
    /// completely unrestricted, so this set is the confinement's whole reach — and sending a kernel a bit
    /// its ABI predates makes <c>create_ruleset</c> fail outright, which is why it is masked by version.
    ///
    /// <para><c>LANDLOCK_ACCESS_FS_IOCTL_DEV</c> (ABI v5) is deliberately left UNHANDLED: it governs
    /// <c>ioctl</c> on character devices, which is not a write to the filesystem, and handling it without
    /// granting it would deny the terminal and device ioctls a runtime legitimately makes — the same
    /// reason the macOS profile carries an explicit <c>(allow file-ioctl …)</c>.</para>
    /// </summary>
    private static ulong HandledAccess(int abi)
    {
        ulong handled = AccessExecute | AccessWriteFile | AccessReadFile | AccessReadDirectory
            | AccessRemoveDirectory | AccessRemoveFile | AccessMakeCharacter | AccessMakeDirectory
            | AccessMakeRegular | AccessMakeSocket | AccessMakeFifo | AccessMakeBlock | AccessMakeSymbolic;

        if (abi >= 2)
        {
            handled |= AccessRefer;
        }

        if (abi >= 3)
        {
            handled |= AccessTruncate;
        }

        return handled;
    }

    /// <summary>Grants <paramref name="access"/> beneath <paramref name="path"/>. The kernel resolves the
    /// path once, here, through the descriptor — so a run directory reached through a symlink needs none
    /// of the canonicalisation the macOS profile's string rules do.</summary>
    private static bool Allow(int ruleset, string path, ulong access, out string? failure)
    {
        int descriptor = LinuxNative.Open(path);
        if (descriptor < 0)
        {
            failure = "the Landlock rule for " + path + " could not be opened: " + LinuxNative.LastError();
            return false;
        }

        try
        {
            var rule = new PathBeneathAttribute { AllowedAccess = access, ParentDescriptor = descriptor };
            if (SyscallAddRule(AddRuleSyscall, ruleset, RulePathBeneath, ref rule, 0) != 0)
            {
                failure = "the Landlock rule for " + path + " was refused: " + LinuxNative.LastError();
                return false;
            }

            failure = null;
            return true;
        }
        finally
        {
            LinuxNative.Close(descriptor);
        }
    }

    /// <summary><c>struct landlock_ruleset_attr</c>, truncated to the one field every ABI defines.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct RulesetAttribute
    {
        public ulong HandledAccessFilesystem;
    }

    /// <summary><c>struct landlock_path_beneath_attr</c> — PACKED in the kernel's headers, so twelve bytes
    /// and not sixteen. Letting the default alignment pad it would hand the kernel a struct of the wrong
    /// size and every rule would be refused.</summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct PathBeneathAttribute
    {
        public ulong AllowedAccess;
        public int ParentDescriptor;
    }

    // glibc's syscall(2) is variadic; each fixed-shape overload below is declared separately rather than
    // marshalling a params array, so the arguments land in the registers the kernel expects.
    [DllImport(LinuxNative.Libc, EntryPoint = "syscall", SetLastError = true)]
    private static extern long SyscallVersion(long number, IntPtr attribute, nuint size, uint flags);

    [DllImport(LinuxNative.Libc, EntryPoint = "syscall", SetLastError = true)]
    private static extern long SyscallCreate(long number, ref RulesetAttribute attribute, nuint size, uint flags);

    [DllImport(LinuxNative.Libc, EntryPoint = "syscall", SetLastError = true)]
    private static extern long SyscallAddRule(
        long number, int ruleset, int ruleType, ref PathBeneathAttribute rule, uint flags);

    [DllImport(LinuxNative.Libc, EntryPoint = "syscall", SetLastError = true)]
    private static extern long SyscallRestrictSelf(long number, int ruleset, uint flags);
}
