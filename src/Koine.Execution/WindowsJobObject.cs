using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace Koine.Execution;

/// <summary>
/// A Windows Job Object holding the scenario child (issue #1759): the platform's own answer to "cap this
/// process's memory and processor time, and make sure it dies with me".
///
/// <para><b>Why a Job Object and not <c>SetInformationProcess</c>:</b> a job's limits apply to the whole
/// tree — anything the child starts is born inside the job — which is the same shape as the host's
/// <c>Kill(entireProcessTree: true)</c>, and <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> makes the handle
/// itself a dead-man's switch: if the editor host crashes, the OS reaps the child rather than leaving it
/// burning a core.</para>
///
/// <para><b>The race we accept:</b> <see cref="Process.Start(ProcessStartInfo)"/> gives no
/// <c>CREATE_SUSPENDED</c> hook, so the child is assigned to the job a moment AFTER it starts. Those first
/// milliseconds are runtime start-up, long before any model-derived code runs, so the window is real but
/// not reachable by the thing the cap defends against. Closing it properly would mean replacing
/// <c>Process.Start</c> with a hand-rolled <c>CreateProcess</c> plus its three redirected pipes — a large
/// amount of interop for a window nothing can currently use.</para>
///
/// <para>Never throws out of <see cref="TryCreate"/>: an unavailable or refused Job Object degrades to a
/// note on the run, per <see cref="ScenarioSandboxOptions"/>'s contract.</para>
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsJobObject : IDisposable
{
    private const int JobObjectExtendedLimitInformation = 9;

    private const uint JobObjectLimitJobTime = 0x00000004;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobObjectLimitDieOnUnhandledException = 0x00000400;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private readonly SafeFileHandle _handle;

    private WindowsJobObject(SafeFileHandle handle) => _handle = handle;

    /// <summary>
    /// Creates a job carrying the requested ceilings, or <c>null</c> with the reason in
    /// <paramref name="failure"/>. Both ceilings are optional; a job with neither is not worth creating,
    /// so that combination returns <c>null</c> without a failure note.
    /// </summary>
    public static WindowsJobObject? TryCreate(long? memoryLimitBytes, TimeSpan? cpuLimit, out string? failure)
    {
        failure = null;
        if (memoryLimitBytes is null && cpuLimit is null)
        {
            return null;
        }

        SafeFileHandle? handle = null;
        try
        {
            handle = CreateJobObjectW(IntPtr.Zero, null);
            if (handle.IsInvalid)
            {
                failure = Reason("the job object could not be created");
                handle.Dispose();
                return null;
            }

            var information = default(JobObjectExtendedLimitInformationStruct);

            // Always on: a child that outlives this handle is a child nobody is watching any more.
            information.BasicLimitInformation.LimitFlags =
                JobObjectLimitKillOnJobClose | JobObjectLimitDieOnUnhandledException;

            if (memoryLimitBytes is { } bytes and > 0)
            {
                information.BasicLimitInformation.LimitFlags |= JobObjectLimitJobMemory;
                information.JobMemoryLimit = (nuint)bytes;
            }

            if (cpuLimit is { } cpu && cpu > TimeSpan.Zero)
            {
                // PerJobUserTimeLimit counts in 100-nanosecond ticks, and the job's default end-of-job
                // action is to terminate every process in it — which is the behaviour we want.
                information.BasicLimitInformation.LimitFlags |= JobObjectLimitJobTime;
                information.BasicLimitInformation.PerJobUserTimeLimit = cpu.Ticks;
            }

            int size = Marshal.SizeOf<JobObjectExtendedLimitInformationStruct>();
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(information, buffer, fDeleteOld: false);
                if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    failure = Reason("the job object's limits were refused");
                    handle.Dispose();
                    return null;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            return new WindowsJobObject(handle);
        }
        catch (Exception ex)
        {
            failure = "the job object could not be created (" + ex.Message + ")";
            handle?.Dispose();
            return null;
        }
    }

    /// <summary>Puts <paramref name="child"/> — and everything it goes on to start — inside the job.</summary>
    public bool TryAssign(Process child, out string? failure)
    {
        failure = null;
        try
        {
            if (AssignProcessToJobObject(_handle, child.Handle))
            {
                return true;
            }

            failure = Reason("the child could not be assigned to the job object");
            return false;
        }
        catch (Exception ex)
        {
            failure = "the child could not be assigned to the job object (" + ex.Message + ")";
            return false;
        }
    }

    public void Dispose() => _handle.Dispose();

    private static string Reason(string what) =>
        what + " (error " + Marshal.GetLastPInvokeError().ToString(System.Globalization.CultureInfo.InvariantCulture) + ")";

    // DllImport rather than LibraryImport: the source generator emits `unsafe` code, and turning
    // AllowUnsafeBlocks on for the whole assembly is a bigger loosening than these three declarations earn.
#pragma warning disable SYSLIB1054
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
#pragma warning restore SYSLIB1054

    /// <summary>Mirrors <c>JOBOBJECT_BASIC_LIMIT_INFORMATION</c>; field order and widths are the ABI.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformationStruct
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    /// <summary>Mirrors <c>IO_COUNTERS</c> — unused, but it sits between the two halves of the extended
    /// structure below, so its size is part of that structure's layout.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCountersStruct
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    /// <summary>Mirrors <c>JOBOBJECT_EXTENDED_LIMIT_INFORMATION</c>.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformationStruct
    {
        public JobObjectBasicLimitInformationStruct BasicLimitInformation;
        public IoCountersStruct IoInfo;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }
}
