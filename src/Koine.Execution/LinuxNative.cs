using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Koine.Execution;

/// <summary>
/// The libc primitives the Linux scenario launcher needs (issue #1781): the two file-descriptor calls
/// <see cref="LinuxLandlock"/> builds its ruleset from, the <c>no_new_privs</c> bit that ruleset requires,
/// and the <c>execv</c> that turns the launcher INTO the command it was asked to confine.
///
/// <para><b>Why a resolver.</b> <c>DllImport("libc")</c> is not reliably loadable by that name: the
/// runtime probes <c>libc</c> / <c>libc.so</c> / <c>liblibc.so</c>, and on a glibc system <c>libc.so</c> is
/// a linker script (present only with the -dev package) rather than an ELF object. The resolver below
/// names the real SONAMEs and, failing those, falls back to the main program handle — every process
/// already has libc mapped, so its exports resolve there whatever the distribution calls the file. Getting
/// this wrong would not break loudly; it would throw <see cref="DllNotFoundException"/> inside a
/// confinement probe, which the sandbox would read as "unavailable" and silently degrade. This is a
/// security boundary, so the load path is made certain rather than left to chance.</para>
/// </summary>
[SupportedOSPlatform("linux")]
internal static class LinuxNative
{
    internal const string Libc = "libc";

    /// <summary>Take the whole path, resolving every symlink, and open it for what it IS rather than for
    /// reading — <c>O_PATH</c> yields a descriptor usable as a Landlock rule's subject without needing
    /// read permission on the object.</summary>
    internal const int O_PATH = 0x200000;

    internal const int O_CLOEXEC = 0x80000;

    /// <summary><c>PR_SET_NO_NEW_PRIVS</c>. Landlock refuses <c>restrict_self</c> without it (unless the
    /// caller has <c>CAP_SYS_ADMIN</c>, which this one deliberately does not).</summary>
    private const int PrSetNoNewPrivs = 38;

    private static int resolverRegistered;

    /// <summary>
    /// Registers the libc resolver once per process. Safe to call from anywhere and any number of times;
    /// it must run before the first P/Invoke in this assembly that names <see cref="Libc"/>.
    /// </summary>
    internal static void EnsureLibcResolver()
    {
        if (Interlocked.Exchange(ref resolverRegistered, 1) != 0)
        {
            return;
        }

        try
        {
            NativeLibrary.SetDllImportResolver(typeof(LinuxNative).Assembly, Resolve);
        }
        catch (Exception)
        {
            // A resolver is already registered for this assembly, or the platform refused one. Either way
            // the plain DllImport probing is what is left, and a failure there is reported as
            // "unavailable" by the callers below rather than thrown at a scenario.
        }
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, Libc, StringComparison.Ordinal))
        {
            return IntPtr.Zero;
        }

        foreach (string candidate in (string[])
                 ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"])
        {
            if (NativeLibrary.TryLoad(candidate, out IntPtr handle))
            {
                return handle;
            }
        }

        try
        {
            return NativeLibrary.GetMainProgramHandle();
        }
        catch (Exception)
        {
            return IntPtr.Zero;
        }
    }

    [DllImport(Libc, EntryPoint = "open", SetLastError = true)]
    private static extern int OpenCore([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport(Libc, EntryPoint = "close", SetLastError = true)]
    private static extern int CloseCore(int descriptor);

    [DllImport(Libc, EntryPoint = "prctl", SetLastError = true)]
    private static extern int PrctlCore(int option, ulong argument2, ulong argument3, ulong argument4, ulong argument5);

    [DllImport(Libc, EntryPoint = "execv", SetLastError = true)]
    private static extern int ExecvCore(IntPtr path, IntPtr[] argv);

    /// <summary>Opens <paramref name="path"/> as an <c>O_PATH</c> descriptor, or <c>-1</c>.</summary>
    internal static int Open(string path)
    {
        EnsureLibcResolver();
        return OpenCore(path, O_PATH | O_CLOEXEC);
    }

    internal static void Close(int descriptor)
    {
        if (descriptor < 0)
        {
            return;
        }

        try
        {
            CloseCore(descriptor);
        }
        catch (Exception)
        {
            // Closing a descriptor this process is about to abandon anyway.
        }
    }

    /// <summary>Sets <c>no_new_privs</c> on this process. Returns <c>0</c> on success.</summary>
    internal static int SetNoNewPrivileges()
    {
        EnsureLibcResolver();
        return PrctlCore(PrSetNoNewPrivs, 1, 0, 0, 0);
    }

    /// <summary>
    /// Replaces this process with <paramref name="path"/>. On success it DOES NOT RETURN — the PID, the
    /// exit code and the three inherited pipes carry on belonging to the new image, which is exactly the
    /// property that lets the host's process-tree kill and stdio protocol survive a confining launcher.
    /// Returns a message only when the exec failed.
    /// </summary>
    internal static string Exec(string path, IReadOnlyList<string> argv)
    {
        EnsureLibcResolver();

        IntPtr pathPointer = IntPtr.Zero;
        var pointers = new IntPtr[argv.Count + 1];
        try
        {
            pathPointer = Marshal.StringToCoTaskMemUTF8(path);
            for (int index = 0; index < argv.Count; index++)
            {
                pointers[index] = Marshal.StringToCoTaskMemUTF8(argv[index]);
            }

            // execv's argument vector is NULL-terminated; the trailing IntPtr.Zero is that terminator.
            pointers[argv.Count] = IntPtr.Zero;

            ExecvCore(pathPointer, pointers);
            return "exec of " + path + " failed: " + LastError();
        }
        catch (Exception ex)
        {
            return "exec of " + path + " could not be attempted: " + ex.Message;
        }
        finally
        {
            // Only ever reached when the exec failed — on success this process no longer exists.
            Marshal.FreeCoTaskMem(pathPointer);
            foreach (IntPtr pointer in pointers)
            {
                Marshal.FreeCoTaskMem(pointer);
            }
        }
    }

    /// <summary>The last <c>errno</c> as a sentence, for a degradation note or the launcher's stderr.</summary>
    internal static string LastError()
    {
        int errno = Marshal.GetLastPInvokeError();
        string message = Marshal.GetLastPInvokeErrorMessage();
        return string.IsNullOrWhiteSpace(message) ? "errno " + errno : message + " (errno " + errno + ")";
    }
}
