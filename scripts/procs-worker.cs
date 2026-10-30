// omo-health process snapshot worker (native replacement for ps-worker.ps1).
// Same protocol: one command per stdin line, one compact JSON line per answer.
//   snap  -> all processes {p, pp, n, c, cpu, pv, ws, rb, wb, cl, wv, wt}
//   os    -> commit charge and physical memory (KB)
//   ports -> listening TCP ports with owning pid
//   ping  -> liveness check
//   exit  -> quit
// Built on first use with the csc.exe that ships with .NET Framework 4 (src/collect/native-worker.mjs).
// A PowerShell host costs ~110 MB and grew ~1.6 MB/min in the 30-minute footprint run; this stays small.
using System;
using System.Globalization;
using System.IO;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

static class OmohProcsWorker
{
	static StreamWriter Out;

	const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
	const uint TOKEN_QUERY = 0x0008;
	const int ProcessCommandLineInformation = 60;
	const int TokenIntegrityLevel = 25;

	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
	[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr buffer, int length, out int returned);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int returned);
	[DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
	[DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
	delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);

	const int WindowTitleMax = 200;

	// One pass over top-level windows: pid -> first non-empty title of a visible window ("" when it has none).
	static Dictionary<int, string> VisibleWindows()
	{
		var owners = new Dictionary<int, string>();
		var title = new StringBuilder(WindowTitleMax + 1);
		EnumWindowsProc callback = (hwnd, lParam) =>
		{
			if (!IsWindowVisible(hwnd)) return true;
			int pid;
			GetWindowThreadProcessId(hwnd, out pid);
			string seen;
			if (owners.TryGetValue(pid, out seen) && seen.Length > 0) return true;
			title.Length = 0;
			GetWindowText(hwnd, title, WindowTitleMax + 1);
			owners[pid] = title.ToString();
			return true;
		};
		EnumWindows(callback, IntPtr.Zero);
		GC.KeepAlive(callback);
		return owners;
	}

	// A non-elevated caller gets no Win32_Process.CommandLine for an elevated process (WMI reads it with a
	// PROCESS_VM_READ it is denied). ProcessCommandLineInformation needs only PROCESS_QUERY_LIMITED_INFORMATION,
	// which a medium-integrity process holds on the same user's elevated processes (Windows 8.1+).
	static string CommandLineOf(int pid)
	{
		var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
		if (process == IntPtr.Zero) return null;
		try
		{
			int length;
			NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
			if (length <= 0 || length > 1 << 20) return null;
			var buffer = Marshal.AllocHGlobal(length);
			try
			{
				if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out length) != 0) return null;
				// UNICODE_STRING { ushort Length; ushort MaximumLength; PWSTR Buffer } followed by the text.
				int bytes = (ushort)Marshal.ReadInt16(buffer);
				var text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
				return bytes > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, bytes / 2) : null;
			}
			finally { Marshal.FreeHGlobal(buffer); }
		}
		finally { CloseHandle(process); }
	}

	// Mandatory integrity level as its RID (0x2000 medium, 0x3000 high, 0x4000 system); -1 when unreadable.
	static int IntegrityOf(int pid)
	{
		var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
		if (process == IntPtr.Zero) return -1;
		IntPtr token = IntPtr.Zero;
		try
		{
			if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return -1;
			int length;
			GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out length);
			if (length <= 0) return -1;
			var buffer = Marshal.AllocHGlobal(length);
			try
			{
				if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, length, out length)) return -1;
				var sid = Marshal.ReadIntPtr(buffer);
				int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
				return count > 0 ? Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))) : -1;
			}
			finally { Marshal.FreeHGlobal(buffer); }
		}
		finally
		{
			if (token != IntPtr.Zero) CloseHandle(token);
			CloseHandle(process);
		}
	}

	static void Main()
	{
		var utf8 = new UTF8Encoding(false);
		Out = new StreamWriter(Console.OpenStandardOutput(), utf8);
		Out.AutoFlush = true;
		var input = new StreamReader(Console.OpenStandardInput(), utf8);
		string line;
		while ((line = input.ReadLine()) != null)
		{
			var cmd = line.Trim();
			if (cmd.Length == 0) continue;
			try
			{
				int target;
				// proc <pid>: the fallback path alone (command line and integrity without WMI), for diagnostics and tests.
				if (cmd.StartsWith("proc ", StringComparison.Ordinal) && int.TryParse(cmd.Substring(5).Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out target))
				{
					var level = IntegrityOf(target);
					Out.WriteLine("{\"cmd\":\"proc\",\"ok\":true,\"data\":{\"p\":" + target + ",\"cl\":" + Q(CommandLineOf(target)) + (level >= 0 ? ",\"il\":" + level : "") + "}}");
					continue;
				}
				switch (cmd)
				{
					case "snap": Snap(); break;
					case "os": Os(); break;
					case "ports": Ports(); break;
					case "ping": Out.WriteLine("{\"cmd\":\"ping\",\"ok\":true,\"data\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}"); break;
					case "exit": Out.WriteLine("{\"cmd\":\"exit\",\"ok\":true}"); return;
					default: Out.WriteLine("{\"cmd\":" + Q(cmd) + ",\"ok\":false,\"error\":\"unknown command\"}"); break;
				}
			}
			catch (Exception e)
			{
				Out.WriteLine("{\"cmd\":" + Q(cmd) + ",\"ok\":false,\"error\":" + Q(e.Message) + "}");
			}
			GC.Collect();
		}
	}

	static string Q(string s)
	{
		if (s == null) return "null";
		var sb = new StringBuilder(s.Length + 2);
		sb.Append('"');
		foreach (var ch in s)
		{
			switch (ch)
			{
				case '"': sb.Append("\\\""); break;
				case '\\': sb.Append("\\\\"); break;
				case '\n': sb.Append("\\n"); break;
				case '\r': sb.Append("\\r"); break;
				case '\t': sb.Append("\\t"); break;
				default:
					if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
					else sb.Append(ch);
					break;
			}
		}
		sb.Append('"');
		return sb.ToString();
	}

	static ulong U(object value)
	{
		return value == null ? 0UL : Convert.ToUInt64(value, CultureInfo.InvariantCulture);
	}

	static ManagementObjectSearcher Searcher(string scope, string query)
	{
		var options = new EnumerationOptions { ReturnImmediately = true, Rewindable = false };
		return new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query), options);
	}

	static void Snap()
	{
		var sb = new StringBuilder(1 << 17);
		sb.Append("{\"cmd\":\"snap\",\"ok\":true,\"ts\":").Append(Q(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)));
		var self = IntegrityOf(System.Diagnostics.Process.GetCurrentProcess().Id);
		if (self >= 0) sb.Append(",\"il\":").Append(self);
		sb.Append(",\"data\":[");
		var first = true;
		var windows = VisibleWindows();
		using (var searcher = Searcher(@"root\cimv2", "SELECT ProcessId, ParentProcessId, Name, CreationDate, KernelModeTime, UserModeTime, PrivatePageCount, WorkingSetSize, ReadTransferCount, WriteTransferCount, CommandLine FROM Win32_Process"))
		using (var results = searcher.Get())
		{
			foreach (ManagementBaseObject row in results)
			{
				using (row)
				{
					var pid = (int)U(row["ProcessId"]);
					var cl = row["CommandLine"] as string;
					if (cl == null && pid > 4) cl = CommandLineOf(pid);
					if (cl != null && cl.Length > 2000) cl = cl.Substring(0, 2000);
					var il = pid > 4 ? IntegrityOf(pid) : -1;
					string created = null;
					var dmtf = row["CreationDate"] as string;
					if (!string.IsNullOrEmpty(dmtf))
					{
						try { created = ManagementDateTimeConverter.ToDateTime(dmtf).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture); }
						catch (Exception) { created = null; }
					}
					if (!first) sb.Append(',');
					first = false;
					sb.Append("{\"p\":").Append(U(row["ProcessId"]))
						.Append(",\"pp\":").Append(U(row["ParentProcessId"]))
						.Append(",\"n\":").Append(Q(row["Name"] as string))
						.Append(",\"c\":").Append(Q(created))
						.Append(",\"cpu\":").Append((U(row["KernelModeTime"]) + U(row["UserModeTime"])) / 10000UL)
						.Append(",\"pv\":").Append(U(row["PrivatePageCount"]))
						.Append(",\"ws\":").Append(U(row["WorkingSetSize"]))
						.Append(",\"rb\":").Append(U(row["ReadTransferCount"]))
						.Append(",\"wb\":").Append(U(row["WriteTransferCount"]))
						.Append(",\"cl\":").Append(Q(cl));
					if (il >= 0) sb.Append(",\"il\":").Append(il);
					string wt;
					var wv = windows.TryGetValue(pid, out wt);
					sb.Append(",\"wv\":").Append(wv ? "true" : "false");
					if (wv && wt.Length > 0) sb.Append(",\"wt\":").Append(Q(wt));
					sb.Append('}');
				}
			}
		}
		sb.Append("]}");
		Out.WriteLine(sb.ToString());
	}

	static void Os()
	{
		using (var searcher = Searcher(@"root\cimv2", "SELECT TotalVirtualMemorySize, FreeVirtualMemory, TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem"))
		using (var results = searcher.Get())
		{
			foreach (ManagementBaseObject row in results)
			{
				using (row)
				{
					Out.WriteLine("{\"cmd\":\"os\",\"ok\":true,\"data\":{\"totalVirtualKB\":" + U(row["TotalVirtualMemorySize"]) + ",\"freeVirtualKB\":" + U(row["FreeVirtualMemory"]) + ",\"totalVisibleKB\":" + U(row["TotalVisibleMemorySize"]) + ",\"freePhysicalKB\":" + U(row["FreePhysicalMemory"]) + "}}");
					return;
				}
			}
		}
		Out.WriteLine("{\"cmd\":\"os\",\"ok\":false,\"error\":\"no Win32_OperatingSystem row\"}");
	}

	static void Ports()
	{
		var sb = new StringBuilder(4096);
		sb.Append("{\"cmd\":\"ports\",\"ok\":true,\"data\":[");
		var first = true;
		using (var searcher = Searcher(@"root\StandardCimv2", "SELECT LocalAddress, LocalPort, OwningProcess FROM MSFT_NetTCPConnection WHERE State = 2"))
		using (var results = searcher.Get())
		{
			foreach (ManagementBaseObject row in results)
			{
				using (row)
				{
					if (!first) sb.Append(',');
					first = false;
					sb.Append("{\"a\":").Append(Q(row["LocalAddress"] as string)).Append(",\"port\":").Append(U(row["LocalPort"])).Append(",\"p\":").Append(U(row["OwningProcess"])).Append('}');
				}
			}
		}
		sb.Append("]}");
		Out.WriteLine(sb.ToString());
	}
}
