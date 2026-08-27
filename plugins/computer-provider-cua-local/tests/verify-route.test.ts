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
sandbox.sandbox_state = types.SimpleNamespace(update=lambda *args, **kwargs: None)
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

  it('keeps one Cua connection warm across frame requests', () => {
    const helperPath = fileURLToPath(new URL('../provider_helper.py', import.meta.url));
    const script = `
import importlib.util
import asyncio
import json
import sys
import types

spec = importlib.util.spec_from_file_location("provider_helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.platform.machine = lambda: "x86_64"
helper.require_supported_cua = lambda: None

counts = {"connect": 0, "disconnect": 0, "screenshot": 0}
class Image:
    pass
class QEMURuntime:
    pass
class ConnectedSandbox:
    async def screenshot_base64(self):
        counts["screenshot"] += 1
        return "image"
    async def get_dimensions(self):
        return (1280, 720)
    async def disconnect(self):
        counts["disconnect"] += 1
class Sandbox:
    @classmethod
    async def connect(cls, name, local=True):
        counts["connect"] += 1
        return ConnectedSandbox()
cua = types.ModuleType("cua")
cua.Image = Image
cua.QEMURuntime = QEMURuntime
cua.Sandbox = Sandbox
sys.modules["cua"] = cua

async def exercise():
    payload = {"name": "test", "image": "linux", "vm": True}
    first = await helper.dispatch("observe", payload)
    second = await helper.dispatch("observe", payload)
    before_close = dict(counts)
    await helper.disconnect_all()
    return first, second, before_close, counts

first, second, before_close, after_close = asyncio.run(exercise())
print(json.dumps({
    "first": first,
    "second": second,
    "before_close": before_close,
    "after_close": after_close,
}))
`;
    const result = spawnSync('python3', ['-c', script, helperPath], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      first: {
        image_base64: 'image',
        width: 1280,
        height: 720,
        mime_type: 'image/png',
        raster_width: 1280,
        raster_height: 720,
        desktop_width: 1280,
        desktop_height: 720,
        source_region: { x: 0, y: 0, width: 1280, height: 720 },
      },
      second: {
        image_base64: 'image',
        width: 1280,
        height: 720,
        mime_type: 'image/png',
        raster_width: 1280,
        raster_height: 720,
        desktop_width: 1280,
        desktop_height: 720,
        source_region: { x: 0, y: 0, width: 1280, height: 720 },
      },
      before_close: { connect: 1, disconnect: 0, screenshot: 2 },
      after_close: { connect: 1, disconnect: 1, screenshot: 2 },
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
