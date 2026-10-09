# Recursive plugins

First-party plugins for [Recursive](https://recursive.computer): computer, machine and server
providers, sync destinations, remote-access connectors, integrations, skills and theme packs.
Recursive itself ships only its core plugins; everything here installs from the plugin list
inside the app.

Each folder under `plugins/` is one plugin with a `plugin.json` manifest. Plugins build against
the public SDK, [`@recursivecomputer/plugin-sdk`](https://www.npmjs.com/package/@recursivecomputer/plugin-sdk),
and nothing else from Recursive.

## Working on a plugin

```bash
bun install
npm run check        # validate manifests and imports, typecheck, run tests
```

- `npm run validate` checks every manifest, that the folder name matches the plugin id, and
  that code imports only npm packages, its own files and the SDK.
- A plugin that uses an SDK runtime value newer than host API 1 declares
  `"engines": { "recursive": { "hostApi": "2" } }`, so older Recursive versions refuse the
  install instead of failing to load it. The validator names the values that need it.
- Bump `version` in `plugin.json` when you change a plugin; installed copies update to newer
  versions.

## How plugins ship

Recursive's release pipeline packs each plugin (operations bundled, UI precompiled, checksummed)
and publishes it to the Recursive Official plugin list. For now the Recursive repository keeps
an exact copy of these folders and packs from it; that copy is synced from this repository and
never edited there.

Third-party plugins live in their own repositories and are listed through
[RecursiveComputer/marketplace](https://github.com/RecursiveComputer/marketplace).

## License

[MIT](LICENSE). Each plugin may state its own license in its folder.
