import { spawn } from "node:child_process";
import path from "node:path";

/** Windows taskkill 在高进程负载下需要更长的有界树清理窗口。 */
export const DEFAULT_PROCESS_CLEANUP_GRACE_MS =
  process.platform === "win32" ? 10_000 : 2_000;
const MAX_NODE_TIMER_MS = 2_147_483_647;
const WINDOWS_JOB_READY_MARKER = Buffer.from("CODEGRAPH_WINDOWS_JOB_READY\n", "ascii");
const WINDOWS_JOB_SHELL_EXECUTABLE = "pwsh.exe";

/**
 * Windows Job host 保留可审计源码与预编译程序集，避免每个短进程重复启动 Roslyn 编译。
 * 程序集由同一对象的 source 编译，摘要在 helper 加载前再次校验。
 */
const WINDOWS_JOB_HOST_ARTIFACT = Object.freeze({
  assemblyBase64: "TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAA4fug4AtAnNIbgBTM0hVGhpcyBwcm9ncmFtIGNhbm5vdCBiZSBydW4gaW4gRE9TIG1vZGUuDQ0KJAAAAAAAAABQRQAATAECAITtaGoAAAAAAAAAAOAAIiALATAAABIAAAACAAAAAAAA+jEAAAAgAAAAQAAAAAAAEAAgAAAAAgAABAAAAAAAAAAEAAAAAAAAAABgAAAAAgAAAAAAAAMAQIUAABAAABAAAAAAEAAAEAAAAAAAABAAAAAAAAAAAAAAAKgxAABPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAACAAAAAAAAAAAAAAACCAAAEgAAAAAAAAAAAAAAC50ZXh0AAAAABIAAAAgAAAAEgAAAAIAAAAAAAAAAAAAAAAAACAAAGAucmVsb2MAAAwAAAAAQAAAAAIAAAAUAAAAAAAAAAAAAAAAAABAAABCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADcMQAAAAAAAEgAAAACAAUAJCMAAIQOAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABswCgB6AgAAAQAAEQB+BQAAChQoAgAABgoGfgUAAAr+AQ0JLAwAKAYAAApzBwAACnoSAf4VBAAAAhYMABIE/hUHAAACEgR8KwAABCAAIAAAfR4AAATQBwAAAigIAAAKKAkAAAoTBREFKAoAAAoTBgARBBEGFigBAAArAAYfCREGEQUoAwAABhb+ARMLEQssDAAoBgAACnMHAAAKegDeCwARBigMAAAKAADcEgf+FQMAAAISB9ADAAACKAgAAAooCQAACn0GAAAEEgcgAAEAAH0RAAAEEgcf9igJAAAGfRUAAAQSBx/1KAkAAAZ9FgAABBIHH/QoCQAABn0XAAAEAigNAAAKLQMCKwEUA3MOAAAKfgUAAAp+BQAAChcgBAQAAH4FAAAKBBIHEgEoAQAABhb+ARMMEQwsDAAoBgAACnMHAAAKehcMBgd7GAAABCgEAAAGFv4BEw0RDSwMACgGAAAKcwcAAAp6KA8AAApyAQAAcG8QAAAKEwgoEQAAChMJEQkRCBYRCI5pbxIAAAoAEQlvEwAACgAHexkAAAQoBQAABhX+ARMOEQ4sDAAoBgAACnMHAAAKegd7GAAABBUoBgAABhX+ARMPEQ8sDAAoBgAACnMHAAAKegd7GAAABBIKKAcAAAYW/gETEBEQLAwAKAYAAApzBwAACnoRChMR3YEAAAAmAAgsEgd7GAAABH4FAAAK/gEW/gErARYTEhESLA8AB3sYAAAEFygIAAAGJgD+GgAHexkAAAR+BQAACv4BFv4BExMREywOAAd7GQAABCgKAAAGJgAHexgAAAR+BQAACv4BFv4BExQRFCwOAAd7GAAABCgKAAAGJgAGKAoAAAYmANwRESoAAEFMAAACAAAAYwAAADAAAACTAAAACwAAAAAAAAAAAAAALwAAAMcBAAD2AQAALwAAAAYAAAECAAAALwAAAPYBAAAlAgAAUgAAAAAAAABCU0pCAQABAAAAAAAMAAAAdjQuMC4zMDMxOQAAAAAFAGwAAAAUBQAAI34AAIAFAAB8BwAAI1N0cmluZ3MAAAAA/AwAADwAAAAjVVMAOA0AABAAAAAjR1VJRAAAAEgNAAA8AQAAI0Jsb2IAAAAAAAAAAgAAAVcdAhQJCgAAAPoBMwAWAAABAAAAEQAAAAcAAAAwAAAACwAAAB4AAAATAAAABQAAAAQAAAABAAAAAQAAAAoAAAABAAAABAAAAAUAAAABAAAAAAB2AwEAAAAAAAYAiQKEBAYAqQKEBAYATQJFBA8ApAQAAAYAcQKEBAYABgaOAwYA/wMtBwYAhwPQAAYAPQKOAwYAPgSOAwoASwNlBA4AygNTAwYAQgKOAwYAvwGOAwYAEwOOAwYACgMtBxIA/QGOAwAAAAAZAAAAAAABAAEAgQEQAO0GAAAZAAEAAQALARAAxAAAACUABgAMAAsBEABpAAAAJQAYAAwACwEQAH0AAAAlABwADAALARAA7wAAACUAJQAMAAsBEACfAAAAJQArAAwAUYAiAJ0AUYD7AJ0AUYBWAJ0AUYAzAJ0AUYDaAJ0ABgAtAZ0ABgCPAaAABgD1A6AABgAFAqAABgAlAZ0ABgApAZ0ABgDHAp0ABgDPAp0ABgA4BZ0ABgBGBZ0ABgBhAp0ABgAwBZ0ABgBGB6MABgABAKMABgANAC0ABgAFBy0ABgAiBy0ABgAfBC0ABgCnBS0ABgBYAS0ABgA/AZ0ABgA0AZ0ABgAhBqYABgANBqYABgAlBZ0ABgDXAqkABgDtAqkABgA5Bp0ABgBjB6kABgB1BZ0ABgBUBZ0ABgB6BqwABgCNBqwABgChBqwABgC1BqwABgDHBqwABgDaBqwABgCoA68ABgDdA7MABgBbBqkABgBMBqkABgB5AakABgBnAakAAAAAAIAAkSAWAbcAAQAAAAAAgACRILgFygALAAAAAACAAJEgyAXQAA0AAAAAAIAAkSDgBdgAEQAAAAAAgACRIEsB3gATAAAAAACAAJEg+QXjABQAAAAAAIAAkSCDBekAFgAAAAAAgACRIJYF8AAYAAAAAACAAJEgsgFBABoAAAAAAIAAkSDRAfYAGwBQIAAAAACWANkD+wAcAAAAAQANAgAAAgAxAgAAAwDhBAAABADQBAAABQCzBAAABgAXBQAABwBuBgAACABSBwAACQDkAwIACgCVAwAAAQDCBAAAAgAdAgAAAQAwAQAAAgBkBQAAAwC+AwAABAAgAwAAAQAwAQAAAgCwBQAAAQBgAQAAAQDvAQAAAgBYBAAAAQCwBQIAAgCaAQAAAQCwBQAAAgCaAQAAAQCjAQAAAQDvAQAAAQANAgAAAgAxAgAAAwBSBwkAKQQBABEAKQQGABkAKQQKACkAKQQBAFEA8AMtAFkADQQwAGEAKQQBAGkA3QE0AFkAAwM7AFkAMgNBAFkALwRGAFkAPwNUAHkAbAdZADkAKQReAIEAXwBjAIEA8wRoAIkADwduAEEARwJzAEEAGgMGAAkABACEAAkACACJAAkADACOAAkAEACTAAkAFACYACcAIwAzAS4ACwACAS4AEwALAS4AGwAqARAAaQNEAQMAFgEBAEABBQC4BQEAQAEHAMgFAQBAAQkA4AUBAEABCwBLAQEAQAENAPkFAQBAAQ8AgwUBAEABEQCWBQEAAAETALIBAQAAARUA0QEBAASAAAAAAAAAAAAAAAAAAAAAADkHAAAKAAAAAAAAAAAAAAB7ACICAAAAAAoAAAAAAAAAAAAAAHsAZQQAAAAACgAAAAAAAAAAAAAAewD8BAAAAAAKAAAAAAAAAAAAAAB7APYBAAAAAAMAAgAEAAIABQACAAYAAgAHAAIAFwBPAAAAAGNiUmVzZXJ2ZWQyAGxwUmVzZXJ2ZWQyADxNb2R1bGU+AENSRUFURV9TVVNQRU5ERUQASk9CX09CSkVDVF9MSU1JVF9LSUxMX09OX0pPQl9DTE9TRQBJTkZJTklURQBnZXRfQVNDSUkAUFJPQ0VTU19JTkZPUk1BVElPTgBKT0JPQkpFQ1RfQkFTSUNfTElNSVRfSU5GT1JNQVRJT04ASk9CT0JKRUNUX0VYVEVOREVEX0xJTUlUX0lORk9STUFUSU9OAFNUQVJUVVBJTkZPAFN5c3RlbS5JTwBTVEFSVEZfVVNFU1RESEFORExFUwBJT19DT1VOVEVSUwBDUkVBVEVfVU5JQ09ERV9FTlZJUk9OTUVOVABDcmVhdGVQcm9jZXNzVwBkd1gAZHdZAGNiAGpvYgBkd1RocmVhZElkAGR3UHJvY2Vzc0lkAFJlc3VtZVRocmVhZABoVGhyZWFkAHRocmVhZABQZWFrSm9iTWVtb3J5VXNlZABQZWFrUHJvY2Vzc01lbW9yeVVzZWQAbHBSZXNlcnZlZABleGl0Q29kZQBzdGFuZGFyZEhhbmRsZQBHZXRTdGRIYW5kbGUAUnVudGltZVR5cGVIYW5kbGUAQ2xvc2VIYW5kbGUAR2V0VHlwZUZyb21IYW5kbGUAaGFuZGxlAFN5c3RlbS5Db25zb2xlAGxwVGl0bGUAYXBwbGljYXRpb25OYW1lAG5hbWUAU3lzdGVtLlJ1bnRpbWUAY29tbWFuZExpbmUAVmFsdWVUeXBlAFdyaXRlAERlYnVnZ2FibGVBdHRyaWJ1dGUAZHdGaWxsQXR0cmlidXRlAFJlZlNhZmV0eVJ1bGVzQXR0cmlidXRlAENvbXBpbGF0aW9uUmVsYXhhdGlvbnNBdHRyaWJ1dGUAUnVudGltZUNvbXBhdGliaWxpdHlBdHRyaWJ1dGUAZHdYU2l6ZQBkd1lTaXplAE1pbmltdW1Xb3JraW5nU2V0U2l6ZQBNYXhpbXVtV29ya2luZ1NldFNpemUAU2l6ZU9mAEVuY29kaW5nAFN0cmluZwBGbHVzaABpbmZvcm1hdGlvbkxlbmd0aABBbGxvY0hHbG9iYWwARnJlZUhHbG9iYWwATWFyc2hhbABTeXN0ZW0uQ29tcG9uZW50TW9kZWwAa2VybmVsMzIuZGxsAHcwcjBhMnR2LjR2di5kbGwAU3RyZWFtAFN5c3RlbQBwcm9jZXNzSW5mb3JtYXRpb24AQmFzaWNMaW1pdEluZm9ybWF0aW9uAGluZm9ybWF0aW9uAFdpbjMyRXhjZXB0aW9uAFJ1bgBJb0luZm8Ac3RhcnR1cEluZm8AWmVybwBscERlc2t0b3AAU3RyaW5nQnVpbGRlcgBHZXRMYXN0V2luMzJFcnJvcgBoU3RkRXJyb3IALmN0b3IAU3RydWN0dXJlVG9QdHIASW50UHRyAFN5c3RlbS5EaWFnbm9zdGljcwBtaWxsaXNlY29uZHMAU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzAFN5c3RlbS5SdW50aW1lLkNvbXBpbGVyU2VydmljZXMARGVidWdnaW5nTW9kZXMAaW5oZXJpdEhhbmRsZXMAam9iQXR0cmlidXRlcwB0aHJlYWRBdHRyaWJ1dGVzAHByb2Nlc3NBdHRyaWJ1dGVzAEdldEJ5dGVzAE1pY3Jvc29mdC5XaW4zMi5QcmltaXRpdmVzAGNyZWF0aW9uRmxhZ3MATGltaXRGbGFncwBkd0ZsYWdzAGR3WENvdW50Q2hhcnMAZHdZQ291bnRDaGFycwBTY2hlZHVsaW5nQ2xhc3MAaW5mb3JtYXRpb25DbGFzcwBQcmlvcml0eUNsYXNzAEdldEV4aXRDb2RlUHJvY2VzcwBUZXJtaW5hdGVQcm9jZXNzAGhQcm9jZXNzAHByb2Nlc3MAQ3JlYXRlSm9iT2JqZWN0AFNldEluZm9ybWF0aW9uSm9iT2JqZWN0AEFzc2lnblByb2Nlc3NUb0pvYk9iamVjdABXYWl0Rm9yU2luZ2xlT2JqZWN0AFBlckpvYlVzZXJUaW1lTGltaXQAUGVyUHJvY2Vzc1VzZXJUaW1lTGltaXQAQWN0aXZlUHJvY2Vzc0xpbWl0AEpvYk1lbW9yeUxpbWl0AFByb2Nlc3NNZW1vcnlMaW1pdABlbnZpcm9ubWVudABSZWFkT3BlcmF0aW9uQ291bnQAV3JpdGVPcGVyYXRpb25Db3VudABPdGhlck9wZXJhdGlvbkNvdW50AFJlYWRUcmFuc2ZlckNvdW50AFdyaXRlVHJhbnNmZXJDb3VudABPdGhlclRyYW5zZmVyQ291bnQAQ29kZUdyYXBoV2luZG93c0pvYkhvc3QAaFN0ZElucHV0AE9wZW5TdGFuZGFyZE91dHB1dABoU3RkT3V0cHV0AFN5c3RlbS5UZXh0AHcwcjBhMnR2LjR2dgB3U2hvd1dpbmRvdwBjdXJyZW50RGlyZWN0b3J5AEFmZmluaXR5AElzTnVsbE9yRW1wdHkAAAAAOUMATwBEAEUARwBSAEEAUABIAF8AVwBJAE4ARABPAFcAUwBfAEoATwBCAF8AUgBFAEEARABZAAoAAADYKL7QInB2SIKjgr+WeYC6AAQgAQEIAyAAAQUgAQERERwHFRgREAICERwIGBEMHQUSIQkCAgICAgIIAgICAgYYAwAACAYAARI1ETkFAAEIEjUEAAEYCAgQAQMBHgAYAgQKAREcBAABARgEAAECDgQgAQEOBAAAEkEFIAEdBQ4EAAASIQcgAwEdBQgICLA/X38R1Qo6BAQAAAAEAAQAAAT/////BAAgAAAEAAEAAAIGCQIGDgIGBgIGCgIGGQIGCwMGERQDBhEYEgAKAg4SHRgYAgkYDhARDBAREAUAAhgYDgcABAIYCBgJBQACAhgYBAABCRgFAAIJGAkGAAICGBAJBQACAhgJBAABAhgGAAMIDg4OCAEACAAAAAAAHgEAAQBUAhZXcmFwTm9uRXhjZXB0aW9uVGhyb3dzAQgBAAcBAAAAAAgBAAsAAAAAANAxAAAAAAAAAAAAAOoxAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAADcMQAAAAAAAAAAAAAAAF9Db3JEbGxNYWluAG1zY29yZWUuZGxsAAAAAAD/JQAgABAAMAAADAAAAPwxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  assemblySha256: "6c6cf74ee292fe308ad22b5ffa4f36bf1fd6062aded5065d9ddb44cc8f0a6d47",
  source: String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CodeGraphWindowsJobHost {
  private const uint CREATE_SUSPENDED = 0x00000004;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint INFINITE = 0xFFFFFFFF;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const uint STARTF_USESTDHANDLES = 0x00000100;

  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFO {
    public uint cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public uint dwX;
    public uint dwY;
    public uint dwXSize;
    public uint dwYSize;
    public uint dwXCountChars;
    public uint dwYCountChars;
    public uint dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetStdHandle(int standardHandle);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static int Run(string applicationName, string commandLine, string currentDirectory) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool created = false;
    try {
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int limitSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr limitPointer = Marshal.AllocHGlobal(limitSize);
      try {
        Marshal.StructureToPtr(limits, limitPointer, false);
        if (!SetInformationJobObject(job, 9, limitPointer, (uint)limitSize)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      } finally {
        Marshal.FreeHGlobal(limitPointer);
      }

      STARTUPINFO startup = new STARTUPINFO();
      startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);
      if (!CreateProcessW(
        String.IsNullOrEmpty(applicationName) ? null : applicationName,
        new StringBuilder(commandLine),
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        IntPtr.Zero,
        currentDirectory,
        ref startup,
        out process)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      created = true;
      if (!AssignProcessToJobObject(job, process.hProcess)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      byte[] ready = Encoding.ASCII.GetBytes("CODEGRAPH_WINDOWS_JOB_READY\n");
      System.IO.Stream output = Console.OpenStandardOutput();
      output.Write(ready, 0, ready.Length);
      output.Flush();
      if (ResumeThread(process.hThread) == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      if (WaitForSingleObject(process.hProcess, INFINITE) == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return unchecked((int)exitCode);
    } catch {
      if (created && process.hProcess != IntPtr.Zero) {
        TerminateProcess(process.hProcess, 1);
      }
      throw;
    } finally {
      if (process.hThread != IntPtr.Zero) { CloseHandle(process.hThread); }
      if (process.hProcess != IntPtr.Zero) { CloseHandle(process.hProcess); }
      // 关闭 Job 的最后一个句柄是内核级收敛点，孤儿化后代也会在此被终止。
      CloseHandle(job);
    }
  }
}
`,
});

const WINDOWS_JOB_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$assemblyBytes = [Convert]::FromBase64String('${WINDOWS_JOB_HOST_ARTIFACT.assemblyBase64}')
$assemblyDigest = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData($assemblyBytes)
).ToLowerInvariant()
if ($assemblyDigest -ne '${WINDOWS_JOB_HOST_ARTIFACT.assemblySha256}') {
  throw 'Windows Job host assembly digest mismatch.'
}
[void][Reflection.Assembly]::Load($assemblyBytes)

function Decode-CodeGraphValue([string] $name) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($name))
}

$applicationName = Decode-CodeGraphValue $env:CODEGRAPH_JOB_APPLICATION
$commandLine = Decode-CodeGraphValue $env:CODEGRAPH_JOB_COMMAND_LINE
$workingDirectory = Decode-CodeGraphValue $env:CODEGRAPH_JOB_WORKING_DIRECTORY
Remove-Item Env:CODEGRAPH_JOB_APPLICATION -ErrorAction SilentlyContinue
Remove-Item Env:CODEGRAPH_JOB_COMMAND_LINE -ErrorAction SilentlyContinue
Remove-Item Env:CODEGRAPH_JOB_WORKING_DIRECTORY -ErrorAction SilentlyContinue
$exitCode = [CodeGraphWindowsJobHost]::Run($applicationName, $commandLine, $workingDirectory)
exit $exitCode
`;
/** 预编码避免高并发时通过 PowerShell stdin 解析 host 脚本造成额外启动阻塞。 */
const WINDOWS_JOB_HOST_ENCODED_COMMAND = Buffer.from(
  WINDOWS_JOB_HOST_SCRIPT,
  "utf16le",
).toString("base64");

/**
 * 以 shell:false 执行进程，并用绝对 deadline、升级终止和有界输出保证最终收敛。
 *
 * @param {{args:string[],cleanupProcessTree?:(child:import("node:child_process").ChildProcess,timeoutMs:number)=>Promise<void>,cleanupProcessTreeOnExit?:boolean,cwd:string,env?:NodeJS.ProcessEnv,executable:string,killGraceMs?:number,outputLimitBytes?:number,spawnProcess?:typeof spawn,timeoutMs:number,windowsVerbatimArguments?:boolean}} options 进程执行参数。
 */
export function runProcessWithDeadline(options) {
  const timeoutMs = options.timeoutMs;
  const killGraceMs = options.killGraceMs ?? DEFAULT_PROCESS_CLEANUP_GRACE_MS;
  const outputLimitBytes = options.outputLimitBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_NODE_TIMER_MS ||
    !Number.isSafeInteger(killGraceMs) ||
    killGraceMs <= 0 ||
    killGraceMs > MAX_NODE_TIMER_MS ||
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes <= 0
  ) {
    throw new TypeError("进程 deadline 与终止宽限必须是 Node timer 上限内的正安全整数，输出上限必须是正安全整数。");
  }
  return new Promise((resolve) => {
    const stdout = createBoundedCollector(outputLimitBytes);
    const stderr = createBoundedCollector(outputLimitBytes);
    let child;
    let deadline;
    let forceKill;
    let settleFallback;
    let postExitDeadline;
    let bootstrapDeadline;
    let settled = false;
    let timedOut = false;
    let closeObserved = false;
    let resolveRootClose;
    const rootClosePromise = new Promise((resolve) => {
      resolveRootClose = resolve;
    });
    let cleanupStarted = false;
    let cleanupSucceeded = options.cleanupProcessTreeOnExit === false;
    let exitResult = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      clearTimeout(settleFallback);
      clearTimeout(postExitDeadline);
      clearTimeout(bootstrapDeadline);
      resolve({
        ...result,
        stderr: stderr.bytes(),
        stderrBytes: stderr.totalBytes(),
        stderrTruncated: stderr.truncated(),
        stdout: stdout.bytes(),
        stdoutBytes: stdout.totalBytes(),
        stdoutTruncated: stdout.truncated(),
      });
    };
    const finishExitedProcess = () => {
      if (exitResult !== null && closeObserved && cleanupSucceeded) {
        finish(exitResult);
      }
    };
    const beginExitCleanup = () => {
      if (cleanupStarted) {
        finishExitedProcess();
        return;
      }
      cleanupStarted = true;
      // close 依赖后代释放继承的 stdio；无论 cleanup Promise 如何结束都保留硬收敛上限。
      postExitDeadline = setTimeout(() => {
        finish(postExitFailure(cleanupSucceeded ? "EPIPEOPEN" : "EPROCESSCLEANUPTIMEOUT"));
      }, killGraceMs);
      if (cleanupSucceeded) {
        finishExitedProcess();
        return;
      }
      const cleanup = options.cleanupProcessTree ?? ((cleanupChild, cleanupTimeoutMs) =>
        cleanupProcessTreeAfterExit(
          cleanupChild,
          cleanupTimeoutMs,
          (remainingMs) => waitForRootClose(rootClosePromise, closeObserved, remainingMs),
        ));
      void Promise.resolve()
        .then(() => cleanup(child, killGraceMs))
        .then(() => {
          if (settled) {
            return;
          }
          cleanupSucceeded = true;
          finishExitedProcess();
        })
        .catch(() => {
          finish(postExitFailure("EPROCESSCLEANUP"));
        });
    };
    try {
      const spawnProcess = options.spawnProcess ??
        (process.platform === "win32" ? spawnWindowsJobHostedProcess : spawn);
      child = spawnProcess(options.executable, options.args, {
        cwd: options.cwd,
        /** Windows 也建立独立进程组，使 deadline 能先广播 SIGBREAK 阻止后代继续执行。 */
        detached: true,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments === true,
      });
      if (options.spawnProcess === undefined && process.platform === "win32") {
        child.codegraphWindowsJobHosted = true;
      }
    } catch (error) {
      finish(spawnError(error));
      return;
    }
    const startExecutionDeadline = () => {
      if (deadline !== undefined || settled || exitResult !== null) {return;}
      deadline = setTimeout(() => {
        if (settled || exitResult !== null) {
          return;
        }
        timedOut = true;
        if (process.platform === "win32") {
          /** 先向独立进程组广播终止，再由 taskkill /T /F 验证并收敛完整进程树。 */
          void terminateProcessTree(
            child,
            "SIGKILL",
            killGraceMs,
            (remainingMs) => waitForRootClose(rootClosePromise, closeObserved, remainingMs),
          )
            .then(
              () => finish(timeoutResult()),
              () => finish(postExitFailure("EPROCESSCLEANUP")),
            );
          return;
        }
        void terminateProcessTree(child, "SIGTERM", killGraceMs).catch(() => undefined).finally(() => {
          forceKill = setTimeout(() => {
            void terminateProcessTree(child, "SIGKILL", killGraceMs).catch(() => undefined).finally(() => {
              settleFallback = setTimeout(() => finish(timeoutResult()), killGraceMs);
            });
          }, killGraceMs);
        });
      }, timeoutMs);
    };
    let waitingForJobReady = child.codegraphWindowsJobHosted === true;
    let readinessBytes = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      if (!waitingForJobReady) {
        stdout.append(chunk);
        return;
      }
      readinessBytes = Buffer.concat([readinessBytes, Buffer.from(chunk)]);
      if (readinessBytes.length < WINDOWS_JOB_READY_MARKER.length) {return;}
      if (!readinessBytes.subarray(0, WINDOWS_JOB_READY_MARKER.length)
        .equals(WINDOWS_JOB_READY_MARKER)) {
        timedOut = true;
        void terminateProcessTree(child, "SIGKILL", killGraceMs).catch(() => undefined)
          .finally(() => finish(postExitFailure("EPROCESSCLEANUP")));
        return;
      }
      waitingForJobReady = false;
      clearTimeout(bootstrapDeadline);
      const remaining = readinessBytes.subarray(WINDOWS_JOB_READY_MARKER.length);
      if (remaining.length > 0) {stdout.append(remaining);}
      readinessBytes = Buffer.alloc(0);
      startExecutionDeadline();
    });
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => {
      if (!timedOut) {
        finish(spawnError(error));
      }
    });
    child.once("exit", (code, signal) => {
      if (timedOut || settled) {
        return;
      }
      clearTimeout(bootstrapDeadline);
      // 主进程已经退出后，原执行 deadline 不得再覆盖其真实退出结论。
      clearTimeout(deadline);
      exitResult = processExitResult(code, signal);
      beginExitCleanup();
    });
    child.once("close", (code, signal) => {
      closeObserved = true;
      resolveRootClose();
      if (timedOut) {
        return;
      }
      clearTimeout(bootstrapDeadline);
      if (exitResult === null) {
        clearTimeout(deadline);
        exitResult = processExitResult(code, signal);
        beginExitCleanup();
      }
      finishExitedProcess();
    });
    if (waitingForJobReady) {
      /** helper 启动也只能消费既有 cleanup grace；未建立 Job 时必须 fail closed。 */
      bootstrapDeadline = setTimeout(() => {
        timedOut = true;
        void terminateProcessTree(child, "SIGKILL", killGraceMs).catch(() => undefined)
          .finally(() => finish(postExitFailure("EPROCESSCLEANUP")));
      }, killGraceMs);
    } else {
      startExecutionDeadline();
    }
  });
}

/** 正常退出后使用独立 deadline 清理残留后代，不复用已完成的执行 deadline。 */
function cleanupProcessTreeAfterExit(child, timeoutMs, waitForRootClose) {
  if (process.platform !== "win32") {
    return terminateProcessTree(child, "SIGTERM", timeoutMs).then(() =>
      terminateProcessTree(child, "SIGKILL", timeoutMs),
    );
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return Promise.resolve();
  }
  return terminateWindowsProcessTree(
    child,
    timeoutMs,
    runWindowsTaskkill,
    verifyWindowsDescendantsConverged,
    waitForRootClose,
  );
}

/**
 * Windows 先广播独立进程组信号；taskkill 128 仅说明根 PID 不存在，必须在同一宽限内
 * 追加后代级只读快照证明，才能结算完整进程树已经收敛。
 */
async function terminateWindowsProcessTree(
  child,
  timeoutMs,
  runTaskkill = runWindowsTaskkill,
  verifyDescendants = verifyWindowsDescendantsConverged,
  waitForRootClose = async (_timeoutMs) => undefined,
) {
  const cleanupDeadline = Date.now() + timeoutMs;
  if (child.codegraphWindowsJobHosted === true) {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /** close 等待仍会在同一 cleanup grace 内证明 helper 与 Job 已收敛。 */
      }
    }
    const remainingMs = cleanupDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Windows Job Object cleanup deadline exhausted.");
    }
    await waitForRootClose(remainingMs);
    return;
  }
  const taskkillOutcome = runTaskkill(child.pid, timeoutMs);
  try {
    child.kill("SIGBREAK");
  } catch {
    /** taskkill 仍是权威树级收敛路径，广播失败不能提前结算。 */
  }
  const outcome = await taskkillOutcome;
  const code = outcome?.code ?? 0;
  if (code === 0) {return;}
  if (code !== 128) {
    throw new Error(`taskkill exited with code ${code ?? "unknown"}.`);
  }
  let remainingMs = cleanupDeadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Windows process tree cleanup deadline exhausted.");
  }
  await waitForRootClose(remainingMs);
  remainingMs = cleanupDeadline - Date.now();
  if (remainingMs <= 0 || !await verifyDescendants(child.pid, remainingMs)) {
    throw new Error("Windows detached descendants remain after taskkill root disappearance.");
  }
}

/** 默认 Windows 执行路径用 Job Object 封口目标及其所有代际后代。 */
function spawnWindowsJobHostedProcess(executable, args, options) {
  const commandLine = buildWindowsCommandLine(
    executable,
    args,
    options.windowsVerbatimArguments === true,
  );
  const applicationName = path.win32.isAbsolute(executable) ? executable : "";
  const env = {
    ...(options.env ?? process.env),
    CODEGRAPH_JOB_APPLICATION: Buffer.from(applicationName, "utf8").toString("base64"),
    CODEGRAPH_JOB_COMMAND_LINE: Buffer.from(commandLine, "utf8").toString("base64"),
    CODEGRAPH_JOB_WORKING_DIRECTORY: Buffer.from(options.cwd, "utf8").toString("base64"),
  };
  /** helper 不进入目标目录，避免启动阶段失败时自身工作目录阻塞临时仓库回收。 */
  const helperCwd = process.env.SystemRoot ?? path.win32.parse(options.cwd).root;
  const helper = spawn(
    WINDOWS_JOB_SHELL_EXECUTABLE,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_JOB_HOST_ENCODED_COMMAND],
    {
      ...options,
      cwd: helperCwd,
      detached: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: false,
    },
  );
  return helper;
}

/** 复刻 CreateProcess/CommandLineToArgvW 的反斜线与引号规则。 */
function buildWindowsCommandLine(executable, args, verbatimArguments) {
  const executableText = quoteWindowsCommandArgument(executable);
  if (verbatimArguments) {
    return [executableText, ...args].join(" ");
  }
  return [executableText, ...args.map(quoteWindowsCommandArgument)].join(" ");
}

/** 单个 Windows argv 元素在空白、引号和尾随反斜线处必须保持可逆。 */
function quoteWindowsCommandArgument(value) {
  if (value.length === 0) {return '\"\"';}
  if (!/[\s"]/u.test(value)) {return value;}
  let quoted = '\"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '\"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '\"';
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}\"`;
}

/** 测试注入只替换 taskkill 与后代验证结果，生产调用仍使用真实异步系统命令。 */
export function terminateWindowsProcessTreeForTests(
  child,
  timeoutMs,
  runTaskkill,
  verifyDescendants = async (_rootPid, _timeoutMs) => true,
  waitForRootClose = async (_timeoutMs) => undefined,
) {
  return terminateWindowsProcessTree(
    child,
    timeoutMs,
    () => runTaskkill(),
    verifyDescendants,
    waitForRootClose,
  );
}

/** 使用异步 taskkill 和独立 timeout 回收 Windows 进程树，禁止阻塞事件循环。 */
function runWindowsTaskkill(pid, timeoutMs) {
  return new Promise((resolve, reject) => {
    let complete = false;
    let cleanupChild;
    const finish = (error, outcome) => {
      if (complete) {
        return;
      }
      complete = true;
      clearTimeout(fallback);
      if (error === undefined) {
        resolve(outcome);
      } else {
        reject(error);
      }
    };
    const fallback = setTimeout(() => {
      cleanupChild?.kill();
      finish(new Error("Windows process tree cleanup timed out."));
    }, timeoutMs);
    try {
      cleanupChild = spawn(
        "taskkill.exe",
        ["/PID", `${pid}`, "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      cleanupChild.once("error", (error) => finish(error));
      cleanupChild.once("close", (code) => {
        // 128 只证明根 PID 不存在，调用方必须继续验证后代快照。
        finish(
          code === 0 || code === 128
            ? undefined
            : new Error(`taskkill exited with code ${code ?? "unknown"}.`),
          Object.freeze({ code }),
        );
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("taskkill spawn failed."));
    }
  });
}

/**
 * 通过单次 CIM 进程快照递归检查原根 PID 的全部后代；任何查询失败都拒绝提供收敛证明。
 */
function verifyWindowsDescendantsConverged(rootPid, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      reject(new Error("Windows descendant verification deadline exhausted."));
      return;
    }
    const script = [
      "$ErrorActionPreference='Stop'",
      `$rootProcessId=[uint32]${rootPid}`,
      "$processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
      "$frontier=[System.Collections.Generic.Queue[uint32]]::new()",
      "$seen=[System.Collections.Generic.HashSet[uint32]]::new()",
      "$frontier.Enqueue($rootProcessId)",
      "$found=$false",
      "while($frontier.Count -gt 0){$parent=$frontier.Dequeue();foreach($process in $processes){$processId=[uint32]$process.ProcessId;if([uint32]$process.ParentProcessId -eq $parent -and $seen.Add($processId)){$found=$true;$frontier.Enqueue($processId)}}}",
      "if($found){exit 1}else{exit 0}",
    ].join(";");
    let complete = false;
    let verifier;
    const finish = (error, converged) => {
      if (complete) {return;}
      complete = true;
      clearTimeout(fallback);
      if (error === undefined) {resolve(converged);}
      else {reject(error);}
    };
    const fallback = setTimeout(() => {
      verifier?.kill();
      finish(new Error("Windows descendant verification timed out."), false);
    }, timeoutMs);
    try {
      verifier = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { stdio: "ignore", windowsHide: true },
      );
      verifier.once("error", (error) => finish(error, false));
      verifier.once("close", (code) => {
        if (code === 0) {finish(undefined, true);}
        else if (code === 1) {finish(undefined, false);}
        else {finish(new Error(`descendant verification exited with code ${code ?? "unknown"}.`), false);}
      });
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error("descendant verification spawn failed."),
        false,
      );
    }
  });
}

/** 终止完整进程树；POSIX 使用独立进程组，Windows 使用 taskkill /T。 */
async function terminateProcessTree(child, signal, timeoutMs, waitForRootClose) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(
      child,
      timeoutMs,
      runWindowsTaskkill,
      verifyWindowsDescendantsConverged,
      waitForRootClose,
    );
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) {
      child.kill(signal);
    }
  }
}

/**
 * 在既有清理宽限内等待根进程 close；只消费同一 deadline，不增加轮询或重试。
 */
function waitForRootClose(rootClosePromise, closeObserved, timeoutMs) {
  if (closeObserved) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (error) => {
      if (complete) {return;}
      complete = true;
      clearTimeout(fallback);
      if (error === undefined) {resolve();}
      else {reject(error);}
    };
    const fallback = setTimeout(
      () => finish(new Error("Windows root process close timed out.")),
      timeoutMs,
    );
    void rootClosePromise.then(() => finish(undefined));
  });
}

/** 缓存主进程的真实退出结论，供 close 与独立 cleanup 完成后统一发布。 */
function processExitResult(code, signal) {
  return {
    status: code === 0 ? "pass" : "fail",
    termination:
      signal === null
        ? { code: code ?? 1, kind: "exit" }
        : { kind: "signal", signalName: signal },
  };
}

/** 创建只保留固定上限、同时记录原始总字节数的 collector。 */
function createBoundedCollector(limitBytes) {
  const chunks = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      const remaining = limitBytes - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    },
    bytes: () => Buffer.concat(chunks),
    totalBytes: () => totalBytes,
    truncated: () => totalBytes > capturedBytes,
  };
}

/** 将启动异常收敛为不泄露本机路径或堆栈的稳定 invalid。 */
function spawnError(error) {
  return {
    status: "invalid",
    termination: {
      kind: "spawn-error",
      stableCode:
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "UNKNOWN",
    },
  };
}

/** deadline 到期统一使用稳定 ETIMEDOUT，不依赖平台信号名称。 */
function timeoutResult() {
  return {
    status: "invalid",
    termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
  };
}

/** cleanup 或 stdio 收敛失败统一返回稳定 invalid，不得保留原进程 pass。 */
function postExitFailure(stableCode) {
  return {
    status: "invalid",
    termination: { kind: "spawn-error", stableCode },
  };
}
