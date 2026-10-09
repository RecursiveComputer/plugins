import type { RemoteProvider } from '@recursivecomputer/plugin-sdk';
import { remoteOrigin, remotePort, remoteSetupError, privateRemoteConfig, startRemoteBridge, superviseRemoteProcess, type RemoteProviderHandle } from '@recursivecomputer/plugin-sdk/remote-provider-node';

export function create(): RemoteProvider {
  const handles: RemoteProviderHandle[] = [];
  const stop = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
  };
  return {
    async start(context) {
      try {
      let origin: string, endpoint: string, port: number;
      try {
        origin = remoteOrigin(context.settings.endpoint);
        endpoint = remoteOrigin(context.settings.server);
        port = remotePort(context.settings.port, 18445);
      } catch { remoteSetupError(context, 'Enter your Pangolin server and resource HTTPS origins, and an unused bridge port.'); }
      const id = String(context.settings.site_id ?? '').trim();
      const secret = await context.credentials.get('site_secret');
      if (!id || !secret) remoteSetupError(context, 'Create a dedicated Newt site in Pangolin and add its ID and secret.');
      try { handles.push(await startRemoteBridge(context, { port })); }
      catch { remoteSetupError(context, 'Cannot open the loopback bridge. Choose an unused port.'); }
      const config = await privateRemoteConfig('pangolin', { endpoint, id, secret });
      handles.push(config);
      handles.push(superviseRemoteProcess(context, 'newt', ['--config-file', config.path, '--disable-ssh'], origin, [`pangolin:${new URL(endpoint).hostname}`]));
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
