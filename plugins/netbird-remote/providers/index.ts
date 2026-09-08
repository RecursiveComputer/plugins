import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import type { RemoteProvider } from '@recursive/plugin-sdk';
import { remoteOrigin, remotePort, remoteSetupError, startRemoteBridge, monitorRemoteEndpoint, type RemoteProviderHandle } from '@recursive/plugin-sdk/remote-provider-node';
const exec = promisify(execFile);

export function create(): RemoteProvider {
  const handles: RemoteProviderHandle[] = [];
  const stop = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
  };
  return {
    async start(context) {
      try {
      let origin: string, port: number;
      try { origin = remoteOrigin(context.settings.endpoint); port = remotePort(context.settings.port, 18446); }
      catch { remoteSetupError(context, 'Enter your NetBird reverse proxy HTTPS origin and an unused bridge port.'); }
      let hostname: string;
      try {
        const { stdout } = await exec('netbird', ['status', '--json'], { timeout: 5000, maxBuffer: 1024 * 1024, signal: context.signal });
        const status = JSON.parse(stdout);
        hostname = String(status.netbirdIp ?? '').split('/')[0];
        if (isIP(hostname) !== 4 || status.management?.connected !== true) throw new Error('Disconnected');
      } catch { remoteSetupError(context, 'Install NetBird and connect this device first. The CLI must be readable by Recursive.'); }
      try { handles.push(await startRemoteBridge(context, { port, hostname })); }
      catch { remoteSetupError(context, 'Cannot open the NetBird bridge. Check its assigned address and choose an unused port.'); }
      handles.push(monitorRemoteEndpoint(context, origin, ['netbird']));
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
