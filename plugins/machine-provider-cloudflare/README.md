# Cloudflare Machines

Runs Recursive sessions in [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/): Linux containers owned by a Durable Object, using the `durable_object` scheduling policy (sub-second starts) and filesystem snapshots.

Cloudflare has no REST API for sandboxes, so this plugin has two parts:

- `worker/` — a Worker you deploy to your Cloudflare account. One `RecursiveMachine` Durable Object per machine owns its container through `ctx.container`.
- `provider.ts` — the Recursive machine provider. It calls the Worker with a bearer token.

## Set up (once)

```sh
cd plugins/shared/machine-provider-cloudflare/worker
npm install
npx wrangler deploy                      # needs Containers on your account (Workers Paid)
npx wrangler secret put RECURSIVE_TOKEN  # any long random string
```

Then in Recursive, open the Cloudflare Machines plugin settings and enter the Worker URL that `wrangler deploy` printed and the same token. Cloud machines also need a public URL for this Recursive install (Machines plugin settings).

## How a machine maps onto the container

| Recursive | Worker / Durable Object |
| --- | --- |
| start | `ctx.container.start({ image: runner, entrypoint: sh -c <bootstrap>, env, enableInternet: true })` |
| pause | `snapshotContainer()`, store the handle, `destroy()` |
| resume | `start({ containerSnapshot })`; the entrypoint (runner) runs again with a fresh enrollment |
| keep alive | `setInactivityTimeout(idle)` while the machine has work |
| remove | `destroy()` and delete the Durable Object's storage |

The Durable Object stores the bootstrap environment (including the runner's enrollment and any machine environment you configured) in its own storage in your account.

Snapshots keep the filesystem, not processes: the runner restarts on resume and hands in any unfinished work. A container that Cloudflare stops for inactivity restarts from the last pause snapshot (or the image).
