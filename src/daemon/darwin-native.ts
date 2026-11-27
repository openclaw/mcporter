import koffi from 'koffi';
const lib = koffi.load('/usr/lib/libproc.dylib');
const system = koffi.load('/usr/lib/libSystem.B.dylib');
const info = lib.func('int proc_pidinfo(int pid,int flavor,uint64 arg,void *buffer,int size)');
const list = lib.func('int proc_listpgrppids(int pgid,void *buffer,int size)');
const signal = (() => {
  try {
    return lib.func('int proc_signal_with_audittoken(void *token,int signal)');
  } catch {
    return undefined;
  }
})();
const sysctl = system.func('int sysctlbyname(str name,void *oldValue,void *oldSize,void *newValue,size_t newSize)');
export interface DarwinOwnership {
  boot: string;
  coalition: string;
}
function bootIdentity(): string {
  const value = Buffer.alloc(64),
    length = Buffer.alloc(8);
  length.writeBigUInt64LE(64n);
  if (sysctl('kern.bootsessionuuid', value, length, null, 0) !== 0)
    throw new Error('Cannot establish macOS kernel ownership.');
  const boot = value.toString('utf8').replace(/\0.*$/s, '').toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(boot)) throw new Error('Invalid macOS kernel identity.');
  return boot;
}
function read(pid: number, flavor: number, size: number): Buffer | undefined {
  const buffer = Buffer.alloc(size),
    count = info(pid, flavor, flavor === 13 ? 1 : 0, buffer, size);
  if (count === size) return buffer;
  const error = koffi.errno();
  if (count === 0 && (error === 3 || error === 2)) return undefined;
  throw new Error('macOS process ownership observation failed.');
}
export function darwinOwnership(): DarwinOwnership {
  const row = read(process.pid, 20, 40);
  if (!row || row.readBigUInt64LE(0) <= 1n) throw new Error('Cannot establish launchd coalition ownership.');
  return { boot: bootIdentity(), coalition: String(row.readBigUInt64LE(0)) };
}
function members(pgid: number): number[] {
  for (let capacity = 64; capacity <= 8192; capacity *= 2) {
    const buffer = Buffer.alloc(capacity * 4);
    koffi.errno(0);
    const written = list(pgid, buffer, buffer.length),
      error = koffi.errno();
    if (written < 0 || (written === 0 && error !== 0)) throw new Error('Cannot enumerate daemon process group.');
    if (written >= capacity) continue;
    return Array.from({ length: written }, (_, index) => buffer.readInt32LE(index * 4)).filter((pid) => pid > 0);
  }
  throw new Error('Daemon process group exceeds ownership limit.');
}
/** Coalition membership survives reparenting; the kernel checks PID version again when delivering the signal. */
export async function retireDarwinGroup(pgid: number, ownership: DarwinOwnership): Promise<void> {
  if (ownership.boot !== bootIdentity()) return;
  const deadline = Date.now() + 10000;
  while (true) {
    const pids = members(pgid);
    if (!pids.length) return;
    let owned = 0,
      uncertain = false;
    for (const pid of pids) {
      const bsd = read(pid, 13, 64);
      if (!bsd) {
        uncertain = true;
        continue;
      }
      if (bsd.readUInt32LE(12) === 5) continue;
      const coalition = read(pid, 20, 40);
      if (!coalition) {
        uncertain = true;
        continue;
      }
      if (String(coalition.readBigUInt64LE(0)) !== ownership.coalition) continue;
      const before = read(pid, 17, 56),
        current = read(pid, 13, 64),
        verifiedCoalition = read(pid, 20, 40),
        after = read(pid, 17, 56);
      if (!before || !current || !verifiedCoalition || !after || !before.equals(after)) {
        uncertain = true;
        continue;
      }
      if (String(verifiedCoalition.readBigUInt64LE(0)) !== ownership.coalition) {
        uncertain = true;
        continue;
      }
      if (current.readUInt32LE(12) === 5) continue;
      if (current.readUInt32LE(36) !== process.getuid!() || current.readUInt32LE(8) !== pgid) {
        uncertain = true;
        continue;
      }
      owned++;
      const token = Buffer.alloc(32);
      token.writeUInt32LE(pid, 20);
      token.writeUInt32LE(before.readUInt32LE(32), 28);
      if (!signal) {
        if (Date.now() >= deadline)
          throw new Error(
            'This macOS lacks PID-version-safe signalling; TERM-resistant daemon descendants require manual retirement.'
          );
        continue;
      }
      const result = signal(token, 9);
      if (result !== 0 && result !== 3) throw new Error('macOS daemon descendant could not be retired.');
    }
    if (!owned && !uncertain) {
      let confirmed = true;
      for (const pid of members(pgid)) {
        if (!pids.includes(pid)) {
          confirmed = false;
          break;
        }
        const current = read(pid, 13, 64);
        if (!current) {
          confirmed = false;
          break;
        }
        if (current.readUInt32LE(12) === 5) continue;
        const coalition = read(pid, 20, 40);
        if (!coalition || String(coalition.readBigUInt64LE(0)) === ownership.coalition) {
          confirmed = false;
          break;
        }
      }
      if (confirmed) return;
    }
    if (Date.now() >= deadline) throw new Error('macOS daemon descendants did not retire.');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
