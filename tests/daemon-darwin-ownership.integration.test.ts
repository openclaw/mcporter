import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
it.skipIf(process.platform !== 'darwin')(
  'retires TERM-resistant orphans using kernel coalition membership after the group leader exited',
  async (context) => {
    const koffi = (await import('koffi')).default;
    try {
      koffi.load('/usr/lib/libproc.dylib').func('int proc_signal_with_audittoken(void*,int)');
    } catch {
      context.skip();
      return;
    }
    const { darwinOwnership, retireDarwinGroup } = await import('../src/daemon/darwin-native.js');
    const ownership = darwinOwnership();
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const{spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});leaf.unref();console.log(leaf.pid);setTimeout(()=>process.exit(0),150);`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let data = '';
    child.stdout!.on('data', (chunk) => {
      data += chunk;
    });
    await once(child, 'exit');
    const pid = Number(data.trim());
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 0);
    try {
      await retireDarwinGroup(child.pid!, ownership);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  },
  15000
);
it.skipIf(process.platform !== 'darwin')(
  'the kernel rejects a stale audit-token version without signalling the live process',
  async (context) => {
    const koffi = (await import('koffi')).default;
    const lib = koffi.load('/usr/lib/libproc.dylib');
    const info = lib.func('int proc_pidinfo(int,int,uint64,void*,int)');
    let signal;
    try {
      signal = lib.func('int proc_signal_with_audittoken(void*,int)');
    } catch {
      context.skip();
      return;
    }
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    try {
      const identity = Buffer.alloc(56);
      expect(info(child.pid, 17, 0, identity, 56)).toBe(56);
      const token = Buffer.alloc(32);
      token.writeUInt32LE(child.pid!, 20);
      token.writeUInt32LE(identity.readUInt32LE(32) + 1, 28);
      expect(signal(token, 15)).toBe(3);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      token.writeUInt32LE(identity.readUInt32LE(32), 28);
      const done = once(child, 'exit');
      expect(signal(token, 9)).toBe(0);
      await done;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
);
