import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import type { RemoteProvider } from '@recursive/plugin-sdk';
import { remoteOrigin, remotePort, remoteSetupError, startRemoteBridge, monitorRemoteEndpoint, type RemoteProviderHandle } from '@recursive/plugin-sdk/remote-provider-node';
const exec = promisify(execFile);
// Password inputs can strip pasted line breaks; restore PEM boundaries before parsing.
const pem = (value: string) => value.replaceAll('\\n', '\n').replace(/-----BEGIN ([A-Z ]+)-----\s*/g, '-----BEGIN $1-----\n').replace(/\s*-----END ([A-Z ]+)-----/g, '\n-----END $1-----\n');

export function create(): RemoteProvider {
  const handles: RemoteProviderHandle[] = [];
  const stop = async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
  };
  return {
    async start(context) {
      try {
      let origin: string, port: number;
      try { origin = remoteOrigin(context.settings.endpoint); port = remotePort(context.settings.port, 18447); }
      catch { remoteSetupError(context, 'Enter an HTTPS origin and an unused HTTPS port.'); }
      if (Number(new URL(origin).port || 443) !== port)
        remoteSetupError(context, 'The endpoint HTTPS port must match the bridge port.');
      const network = String(context.settings.network_id ?? '').trim();
      if (!/^[a-f0-9]{16}$/i.test(network)) remoteSetupError(context, 'Enter your 16-character ZeroTier network ID.');
      const cert = await context.credentials.get('tls_certificate');
      const key = await context.credentials.get('tls_private_key');
      if (!cert || !key) remoteSetupError(context, 'Add a trusted TLS certificate and private key for your endpoint hostname.');
      let networks: Array<{ nwid?: string; id?: string; status?: string; assignedAddresses?: string[] }>;
      try {
        const { stdout } = await exec('zerotier-cli', ['-j', 'listnetworks'], { timeout: 5000, maxBuffer: 1024 * 1024, signal: context.signal });
        networks = JSON.parse(stdout);
      } catch { remoteSetupError(context, 'Install ZeroTier and authorize this device on your network. The CLI must be readable by Recursive.'); }
      const joined = Array.isArray(networks) ? networks.find(value => (value.nwid ?? value.id)?.toLowerCase() === network.toLowerCase() && value.status === 'OK') : undefined;
      const hostname = joined?.assignedAddresses?.map(value => value.split('/')[0]).find(value => isIP(value) === 4);
      if (!hostname) remoteSetupError(context, 'Join and authorize this ZeroTier network with an assigned IPv4 address first.');
      try { handles.push(await startRemoteBridge(context, { port, hostname, tls: { cert: pem(cert), key: pem(key) } })); }
      catch { remoteSetupError(context, 'Cannot open the ZeroTier HTTPS bridge. Check the address, unused port, certificate, and matching private key.'); }
      handles.push(monitorRemoteEndpoint(context, origin, [`zerotier:${network.toLowerCase()}`]));
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
