import type { RemoteProvider } from '@recursive/plugin-sdk';
import { remoteOrigin, remoteSetupError, privateRemoteConfig, superviseRemoteProcess, type RemoteProviderHandle } from '@recursive/plugin-sdk/remote-provider-node';

export function create(): RemoteProvider {
  const handles: RemoteProviderHandle[] = [];
  const stop = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
  };
  return {
    async start(context) {
      try {
      let origin: string;
      try { origin = remoteOrigin(context.settings.endpoint); }
      catch { remoteSetupError(context, 'Enter your reserved ngrok HTTPS endpoint.'); }
      const token = await context.credentials.get('authtoken');
      if (!token) remoteSetupError(context, 'Add your ngrok agent authtoken.');
      const config = await privateRemoteConfig('ngrok', {
        version: 3,
        agent: { authtoken: token, web_addr: false, console_ui: false, remote_management: false, update_check: false },
        endpoints: [{ name: 'recursive', url: origin, upstream: { url: context.ingressUrl } }],
      });
      handles.push(config);
      handles.push(superviseRemoteProcess(context, 'ngrok', ['start', 'recursive', '--config', config.path], origin, ['ngrok']));
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
