import type { RemoteProvider } from '@recursivecomputer/plugin-sdk';
import { remoteOrigin, remotePort, remoteSetupError, startRemoteBridge, monitorRemoteEndpoint, type RemoteProviderHandle } from '@recursivecomputer/plugin-sdk/remote-provider-node';

export function create(): RemoteProvider {
  const handles: RemoteProviderHandle[] = [];
  const stop = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
  };
  return {
    async start(context) {
      try {
      let origin: string, port: number;
      try { origin = remoteOrigin(context.settings.endpoint); port = remotePort(context.settings.port, 18444); }
      catch { remoteSetupError(context, 'Enter an HTTPS origin and an unused bridge port from 1024 to 65535.'); }
      try { handles.push(await startRemoteBridge(context, { port })); }
      catch { remoteSetupError(context, 'Cannot open the loopback bridge. Choose an unused port.'); }
      handles.push(monitorRemoteEndpoint(context, origin, [`custom:${new URL(origin).hostname}`]));
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
