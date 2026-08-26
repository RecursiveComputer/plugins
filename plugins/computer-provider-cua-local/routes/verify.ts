import { verifyLocalComputer } from '../provider.js';

interface RouteContext {
  pathname: string;
  req: { method?: string };
  res: unknown;
  send: (res: unknown, status: number, body: unknown) => void;
  db?: { getPluginSettings?: (id: string) => Record<string, unknown> };
}

async function handler(context: RouteContext): Promise<boolean> {
  if (
    context.pathname !== '/api/computer-provider-cua-local/verify' ||
    context.req.method !== 'POST'
  ) {
    return false;
  }

  const settings = context.db?.getPluginSettings?.('computer-provider-cua-local') ?? {};
  const result = await verifyLocalComputer(settings);
  context.send(context.res, result.ok ? 200 : 400, result);
  return true;
}

export default handler;
