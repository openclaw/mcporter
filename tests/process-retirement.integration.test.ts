import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { awaitRetirement, ownedProcessTree, processInventory } from '../src/daemon/process-retirement.js';

it('captures a real owned tree and observes each child until its own exit', async () => {
  const descendant = `
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
process.send({pid:process.pid,leaf:leaf.pid});
process.on('message',()=>{leaf.once('exit',()=>process.exit(0));leaf.kill();});
`;
  const root = spawn(
    process.execPath,
    [
      '-e',
      `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',message=>process.send(message));
process.on('message',()=>{child.once('exit',()=>process.exit(0));child.send('stop');});
`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  const exited = once(root, 'exit');
  try {
    const [message] = (await once(root, 'message')) as [{ pid: number; leaf: number }];
    // A concurrent exact observation of the middle node must not truncate traversal to its child.
    const [tree] = await Promise.all([ownedProcessTree(root.pid!), processInventory([message.pid])]);
    expect(tree.map((item) => item.pid).toSorted((a, b) => a - b)).toEqual(
      [root.pid!, message.pid, message.leaf].toSorted((a, b) => a - b)
    );
    expect(new Set(tree.map((item) => item.owner)).size).toBe(1);
    expect(tree.every((item) => item.born.length > 0)).toBe(true);
    const pending = awaitRetirement(tree);
    const settled = Promise.allSettled([pending]);
    root.send('stop');
    await exited;
    const [result] = await settled;
    if (result?.status === 'rejected') throw result.reason;
    await expect(ownedProcessTree(root.pid!)).rejects.toThrow(/ownership could not be verified/);
  } finally {
    if (root.exitCode === null && root.signalCode === null) root.send('stop');
    await exited;
  }
});
