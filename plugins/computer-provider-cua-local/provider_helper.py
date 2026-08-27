import asyncio
import base64
import json
import platform
import re
import shlex
import shutil
import sys
from importlib.metadata import PackageNotFoundError, version


MINIMUM_CUA_SANDBOX = (0, 4, 3)
X86_64_MACHINES = {"amd64", "x86_64"}
ARM64_MACHINES = {"aarch64", "arm64"}


def version_tuple(value):
    parts = [int(part) for part in re.findall(r"\d+", value)[:3]]
    return tuple((parts + [0, 0, 0])[:3])


def require_supported_cua():
    try:
        installed = version("cua-sandbox")
    except PackageNotFoundError as error:
        raise RuntimeError("Cua Sandbox is not installed.") from error
    if version_tuple(installed) < MINIMUM_CUA_SANDBOX:
        minimum = ".".join(str(part) for part in MINIMUM_CUA_SANDBOX)
        raise RuntimeError(
            f"Cua Sandbox {installed} is too old; Recursive requires {minimum} or newer."
        )


def read_payload():
    raw = sys.stdin.read()
    return json.loads(raw) if raw else {}


def image_for(Image, name, vm):
    normalized = str(name or "linux").lower()
    if normalized not in {"linux", "macos", "windows", "android"}:
        raise ValueError(f"Unsupported local Cua image: {normalized}")
    builder = getattr(Image, normalized)
    if normalized == "linux":
        return builder(kind="vm") if vm else builder(kind="container")
    return builder()


def configure_linux_vm_registry_arch(image, vm):
    if str(image or "linux").lower() != "linux" or not vm:
        return None
    machine = platform.machine().lower()
    if machine not in ARM64_MACHINES:
        return "amd64" if machine in X86_64_MACHINES else None

    # Cua's pinned Ubuntu VM disk is currently published for amd64 only. Its
    # registry resolver otherwise selects the Apple Silicon host architecture,
    # misses that disk, and falls into an unimplemented local Linux builder.
    from cua_sandbox.registry import container_disk

    container_disk._host_architecture = lambda: "amd64"
    return "amd64"


async def connect(Sandbox, name):
    try:
        return await Sandbox.connect(name, local=True)
    except Exception:
        return await Sandbox.resume(name, local=True)


async def run(operation, payload):
    require_supported_cua()
    from cua import Image, QEMURuntime, Sandbox

    guest_arch = configure_linux_vm_registry_arch(
        payload.get("image"), payload.get("vm", True)
    )

    if operation == "status":
        image = str(payload.get("image") or "linux").lower()
        if image == "linux" and payload.get("vm", True) and not shutil.which("qemu-system-x86_64"):
            raise RuntimeError("Local Linux computers require qemu-system-x86_64.")
        if image == "linux" and not payload.get("vm", True) and not shutil.which("docker"):
            raise RuntimeError("Local Linux containers require Docker.")
        if image == "macos" and not shutil.which("lume"):
            raise RuntimeError("Local macOS computers require Lume.")
        await Sandbox.list(local=True)
        return {
            "ready": True,
            "guest_arch": guest_arch,
            "emulated": guest_arch == "amd64" and platform.machine().lower() in ARM64_MACHINES,
        }

    name = payload["name"]
    if operation == "provision":
        runtime = None
        if str(payload.get("image") or "linux").lower() == "linux" and payload.get("vm", True):
            runtime = QEMURuntime(mode="bare-metal", arch="x86_64")
        sandbox = await Sandbox.create(
            image_for(Image, payload.get("image"), payload.get("vm", True)),
            name=name,
            local=True,
            runtime=runtime,
        )
        await sandbox.disconnect()
        return {"sandbox_id": name}
    if operation == "reconnect":
        sandbox = await connect(Sandbox, name)
        await sandbox.disconnect()
        return {"sandbox_id": name}
    if operation == "stop":
        await Sandbox.suspend(name, local=True)
        return {"stopped": True}
    if operation == "destroy":
        await Sandbox.delete(name, local=True)
        return {"destroyed": True}

    sandbox = await connect(Sandbox, name)
    try:
        if operation == "observe":
            image = await sandbox.screenshot_base64()
            width, height = await sandbox.get_dimensions()
            return {"image_base64": image, "width": width, "height": height}
        if operation == "act":
            applied = 0
            for action in payload.get("actions", []):
                kind = action.get("type")
                if kind == "click":
                    if action.get("double"):
                        await sandbox.mouse.double_click(action["x"], action["y"])
                    else:
                        await sandbox.mouse.click(
                            action["x"], action["y"], action.get("button", "left")
                        )
                elif kind == "move":
                    await sandbox.mouse.move(action["x"], action["y"])
                elif kind == "drag":
                    await sandbox.mouse.drag(
                        action["from_x"], action["from_y"], action["to_x"], action["to_y"]
                    )
                elif kind == "scroll":
                    amount = int(action.get("amount", 3))
                    direction = action.get("direction", "down")
                    x = int(action.get("x", 0))
                    y = int(action.get("y", 0))
                    scroll_x = amount if direction == "right" else -amount if direction == "left" else 0
                    scroll_y = -amount if direction == "up" else amount if direction == "down" else 0
                    await sandbox.mouse.scroll(x, y, scroll_x=scroll_x, scroll_y=scroll_y)
                elif kind == "type":
                    await sandbox.keyboard.type(action["text"])
                elif kind == "key":
                    await sandbox.keyboard.keypress(action.get("keys", action.get("key")))
                elif kind == "wait":
                    await asyncio.sleep(float(action.get("ms", 0)) / 1000)
                elif kind == "open":
                    target = shlex.quote(str(action["target"]))
                    await sandbox.shell.run(f"xdg-open {target}")
                else:
                    raise ValueError(f"Unsupported computer action: {kind}")
                applied += 1
            return {"applied": applied}
        if operation == "shell":
            command = str(payload["command"])
            cwd = payload.get("cwd")
            if cwd:
                command = f"cd {shlex.quote(str(cwd))} && {command}"
            timeout = max(1, int(payload.get("timeout_ms", 30000)) // 1000)
            result = await sandbox.shell.run(command, timeout=timeout)
            return {
                "exit_code": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        if operation == "read_file":
            result = await sandbox.shell.run(f"cat -- {shlex.quote(str(payload['path']))}")
            if result.returncode != 0:
                raise RuntimeError(result.stderr or "Could not read sandbox file")
            return {"content": result.stdout}
        if operation == "write_file":
            encoded = base64.b64encode(str(payload.get("content", "")).encode()).decode()
            target = shlex.quote(str(payload["path"]))
            parent = shlex.quote(str(payload["path"]).rsplit("/", 1)[0] or ".")
            content = shlex.quote(encoded)
            result = await sandbox.shell.run(
                f"mkdir -p -- {parent} && printf %s {content} | base64 -d > {target}"
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr or "Could not write sandbox file")
            return {"written": True}
        raise ValueError(f"Unsupported local computer operation: {operation}")
    finally:
        await sandbox.disconnect()


async def main():
    operation = sys.argv[1]
    payload = read_payload()
    result = await run(operation, payload)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
