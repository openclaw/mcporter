// The guardian owns the only non-inheritable job handle and stays outside that job.
export const windowsJobScript = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class McporterJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public IO Counters; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(ref SA attributes,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint rights,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Extended value,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting value,int length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  IntPtr host,job;
  public McporterJob(int pid) { host=OpenProcess(0x00100101,false,pid); if(host==IntPtr.Zero)throw new Win32Exception(); }
  public void Attach(string name,string sid) {
    IntPtr descriptor;uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;"+sid+")",1,out descriptor,out size))throw new Win32Exception();
    try { var sa=new SA { Length=Marshal.SizeOf(typeof(SA)),Descriptor=descriptor };
      job=CreateJobObject(ref sa,name);int error=Marshal.GetLastWin32Error();
      if(job==IntPtr.Zero)throw new Win32Exception(error);
      if(error==183)throw new InvalidOperationException("Job already exists.");
    } finally { LocalFree(descriptor); }
    var limits=new Extended();limits.Basic.Flags=0x2000;
    if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Extended))))throw new Win32Exception();
    bool inside;
    if(!IsProcessInJob(GetCurrentProcess(),job,out inside)||inside)throw new InvalidOperationException("Guardian is inside worker job.");
    if(!AssignProcessToJobObject(job,host))throw new Win32Exception();
  }
  public static int Inspect(string name,bool terminate) {
    IntPtr value=OpenJobObject(terminate?12u:4u,false,name);
    if(value==IntPtr.Zero) { int error=Marshal.GetLastWin32Error();if(error==2)return 0;throw new Win32Exception(error); }
    try { if(terminate&&!TerminateJobObject(value,1))throw new Win32Exception();
      Accounting accounting;
      if(!QueryInformationJobObject(value,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw new Win32Exception();
      return checked((int)accounting.Active);
    } finally { CloseHandle(value); }
  }
  public void Dispose() { if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(host!=IntPtr.Zero){CloseHandle(host);host=IntPtr.Zero;} }
}
'@
function Invoke-McporterJob($request) {
  if ($request.mode -eq 'inspect' -or $request.mode -eq 'terminate') {
    $active=[McporterJob]::Inspect($request.name,($request.mode -eq 'terminate'))
    [Console]::Out.WriteLine((@{active=$active}|ConvertTo-Json -Compress));return
  }
  $job=New-Object McporterJob ([int]$request.pid)
  try {
    [Console]::Out.WriteLine((@{challenge=$request.challenge}|ConvertTo-Json -Compress))
    $ack=[Console]::In.ReadLine()
    if ($ack -ne $request.challenge) { throw 'Worker acknowledgement missing.' }
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $job.Attach($request.name,$sid)
    $proof=@{generation=$request.generation;name=$request.name;pid=$request.pid}|ConvertTo-Json -Compress
    $temporary=$request.proof+'.tmp'
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes($proof);$stream.Write($bytes,0,$bytes.Length);$stream.Flush() } finally { $stream.Dispose() }
    [IO.File]::Move($temporary,$request.proof)
    [Console]::Out.WriteLine('{"ready":true}')
    while ($null -ne ($line=[Console]::In.ReadLine())) {
      $message=$line|ConvertFrom-Json
      if ($message.open) {
        try {
        $url=[Uri]$message.open
        if (!$url.IsAbsoluteUri -or ($url.Scheme -ne 'http' -and $url.Scheme -ne 'https')) { throw 'Invalid browser URL.' }
        $start=New-Object Diagnostics.ProcessStartInfo
        $start.UseShellExecute=$true;$start.FileName=$url.AbsoluteUri
        [void][Diagnostics.Process]::Start($start)
        } catch { } # Browser launch stays best-effort; it must not retire the job.
      }
    }
  } finally { $job.Dispose() }
}
`;
