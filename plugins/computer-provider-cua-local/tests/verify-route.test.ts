import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import computerProvider, { sanitizeLocalComputerDiagnostic } from '../provider.js';
import handler from '../routes/verify.js';

describe('Local Computer onboarding verification route', () => {
  it('uses the provider-neutral frame stream instead of an unsupported display URL', async () => {
    const provider = computerProvider.create({ plugin_id: 'local', settings: {} });

    await expect(provider.liveViewUrl('sandbox-1')).resolves.toBeNull();
  });

  it('keeps the actionable Cua failure and removes Docker credential-helper noise', () => {
    expect(
      sanitizeLocalComputerDiagnostic(
        "Credential helper 'docker-credential-desktop' failed:\nLinux base image building not yet implemented",
      ),
    ).toBe('Linux base image building not yet implemented');
  });

  it('selects Cua’s published amd64 Linux disk on an ARM host', () => {
    const helperPath = fileURLToPath(new URL('../provider_helper.py', import.meta.url));
    const script = `
import importlib.util
import asyncio
import json
import sys
import types

container_disk = types.ModuleType("cua_sandbox.registry.container_disk")
container_disk._host_architecture = lambda: "arm64"
registry = types.ModuleType("cua_sandbox.registry")
registry.container_disk = container_disk
sandbox = types.ModuleType("cua_sandbox")
sandbox.registry = registry
sys.modules["cua_sandbox"] = sandbox
sys.modules["cua_sandbox.registry"] = registry
sys.modules["cua_sandbox.registry.container_disk"] = container_disk

spec = importlib.util.spec_from_file_location("provider_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.platform.machine = lambda: "arm64"
helper.require_supported_cua = lambda: None

captured = {}
class Image:
    @classmethod
    def linux(cls, kind="vm"):
        return {"kind": kind}
class QEMURuntime:
    def __init__(self, **kwargs):
        captured["runtime"] = kwargs
class CreatedSandbox:
    async def disconnect(self):
        return None
class Sandbox:
    @classmethod
    async def create(cls, image, **kwargs):
        captured["create"] = kwargs
        return CreatedSandbox()
cua = types.ModuleType("cua")
cua.Image = Image
cua.QEMURuntime = QEMURuntime
cua.Sandbox = Sandbox
sys.modules["cua"] = cua

guest_arch = helper.configure_linux_vm_registry_arch("linux", True)
asyncio.run(helper.run("provision", {"name": "test", "image": "linux", "vm": True}))
print(json.dumps({
    "guest_arch": guest_arch,
    "registry_arch": container_disk._host_architecture(),
    "qemu_arch": captured["runtime"]["arch"],
    "qemu_mode": captured["runtime"]["mode"],
}))
`;
    const result = spawnSync('python3', ['-c', script, helperPath], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      guest_arch: 'amd64',
      registry_arch: 'amd64',
      qemu_arch: 'x86_64',
      qemu_mode: 'bare-metal',
    });
  });

  it('ignores unrelated requests', async () => {
    const send = vi.fn();

    await expect(
      handler({
        pathname: '/api/other',
        req: { method: 'POST' },
        res: {},
        send,
      }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('verifies the saved Python and virtualization settings', async () => {
    const send = vi.fn();
    const res = {};
    const handled = await handler({
      pathname: '/api/computer-provider-cua-local/verify',
      req: { method: 'POST' },
      res,
      send,
      db: {
        getPluginSettings: () => ({
          pythonPath: 'missing-python-for-local-computer-test',
          image: 'linux',
          virtualMachine: true,
        }),
      },
    });

    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({
        ok: false,
        message: expect.any(String),
        setup_hint: expect.stringContaining("-m pip install --upgrade 'cua-sandbox>=0.4.3' cua"),
      }),
    );
  });
});
