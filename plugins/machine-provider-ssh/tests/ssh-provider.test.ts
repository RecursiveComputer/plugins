import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import { createSshProvider, launchScript } from '../provider.ts';

test('sends the launch script on stdin so the token never reaches either command line', async () => {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const provider = createSshProvider({ host: 'me@box', port: 2222, identityFile: '/k', extraOptions: ['ProxyJump=bastion'] }, async (args, stdin) => {
    calls.push({ args, stdin });
    return 'running';
  });
  await provider.start({ machine_id: 'm', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: "t'ok" } } });
  assert.deepEqual(calls[0]!.args, ['-p', '2222', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', '/k', '-o', 'ProxyJump=bastion', 'me@box', 'sh -s']);
  assert.ok(!calls[0]!.args.join(' ').includes("t'ok"));
  assert.match(calls[0]!.stdin!, /export RECURSIVE_MACHINE_ENROLL='t'\\''ok'/);
  assert.equal(await provider.status!('me@box'), 'running');
});

test('the launch script is valid sh', () => {
  execFileSync('/bin/sh', ['-n'], { input: launchScript('curl x | sh', { A: "b'c" }) });
});
