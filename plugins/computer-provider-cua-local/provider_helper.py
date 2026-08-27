import asyncio
import base64
import hashlib
import io
import json
import math
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version


MINIMUM_CUA_SANDBOX = (0, 4, 3)
X86_64_MACHINES = {"amd64", "x86_64"}
ARM64_MACHINES = {"aarch64", "arm64"}
SANDBOXES = {}
SANDBOX_LOCKS = {}
QMP_PORTS = {}


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


async def connected_sandbox(Sandbox, name):
    sandbox = SANDBOXES.get(name)
    if sandbox is None:
        sandbox = await connect(Sandbox, name)
        SANDBOXES[name] = sandbox
    return sandbox


async def disconnect_sandbox(name):
    sandbox = SANDBOXES.pop(name, None)
    if sandbox is not None:
        await sandbox.disconnect()


async def disconnect_all():
    sandboxes = list(SANDBOXES.values())
    SANDBOXES.clear()
    await asyncio.gather(
        *(sandbox.disconnect() for sandbox in sandboxes), return_exceptions=True
    )


def free_tcp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return candidate.getsockname()[1]


def qmp_port_from_running_process(name):
    if platform.system() == "Windows":
        return None
    result = subprocess.run(
        ["ps", "-axo", "command="],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    for command in result.stdout.splitlines():
        try:
            arguments = shlex.split(command)
        except ValueError:
            continue
        try:
            name_index = arguments.index("-name")
            qmp_index = arguments.index("-qmp")
        except ValueError:
            continue
        if name_index + 1 >= len(arguments) or qmp_index + 1 >= len(arguments):
            continue
        if arguments[name_index + 1].split(",", 1)[0] != name:
            continue
        match = re.match(
            r"^tcp:(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(?:,|$)",
            arguments[qmp_index + 1],
        )
        if match:
            return int(match.group(1))
    return None


def repair_qmp_port_for_suspend(name):
    from cua_sandbox import sandbox_state

    state = sandbox_state.load(name)
    if not state or state.get("runtime_type") != "qemu-baremetal":
        return
    qmp_port = state.get("qmp_port")
    if isinstance(qmp_port, int) and not isinstance(qmp_port, bool) and qmp_port > 0:
        return
    qmp_port = QMP_PORTS.get(name) or qmp_port_from_running_process(name)
    if qmp_port is None:
        raise RuntimeError(
            f"Could not locate the QEMU control port for local computer {name}."
        )
    sandbox_state.update(name, qmp_port=qmp_port)


def positive_integer(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return max(1, round(value))


def normalized_source_region(requested, desktop_width, desktop_height):
    if requested is None:
        return {"x": 0, "y": 0, "width": desktop_width, "height": desktop_height}
    if not isinstance(requested, dict):
        raise ValueError("source_region must contain finite coordinates and dimensions")
    values = [
        requested.get("x"),
        requested.get("y"),
        requested.get("width"),
        requested.get("height"),
    ]
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for value in values
    ):
        raise ValueError("source_region must contain finite coordinates and dimensions")
    x, y, width, height = values
    if width <= 0 or height <= 0:
        raise ValueError("source_region dimensions must be greater than zero")
    left = max(0, min(desktop_width, math.floor(x)))
    top = max(0, min(desktop_height, math.floor(y)))
    right = max(0, min(desktop_width, math.ceil(x + width)))
    bottom = max(0, min(desktop_height, math.ceil(y + height)))
    if right <= left or bottom <= top:
        raise ValueError("source_region must intersect the desktop")
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def normalized_observe_options(options, desktop_width, desktop_height):
    if not isinstance(options, dict):
        options = {}
    requested_format = options.get("format")
    if requested_format not in (None, "png", "webp"):
        raise ValueError("format must be png or webp")
    quality = options.get("quality")
    if isinstance(quality, bool) or not isinstance(quality, (int, float)) or not math.isfinite(quality):
        quality = 80
    else:
        quality = min(100, max(1, round(quality)))
    return {
        "format": "webp" if requested_format == "webp" else "png",
        "quality": quality,
        "max_raster_width": positive_integer(options.get("max_raster_width")),
        "max_raster_height": positive_integer(options.get("max_raster_height")),
        "source_region": normalized_source_region(
            options.get("source_region"), desktop_width, desktop_height
        ),
    }


def optimized_observation(image_base64, desktop_width, desktop_height, options):
    request = normalized_observe_options(options, desktop_width, desktop_height)
    source_region = request["source_region"]
    has_transform = (
        request["format"] == "webp"
        or request["max_raster_width"] is not None
        or request["max_raster_height"] is not None
        or source_region["x"] != 0
        or source_region["y"] != 0
        or source_region["width"] != desktop_width
        or source_region["height"] != desktop_height
    )
    if not has_transform:
        encoded = image_base64.encode("utf-8")
        raster_width = desktop_width
        raster_height = desktop_height
    else:
        try:
            from PIL import Image
        except ImportError as error:
            raise RuntimeError(
                "Local computer frame transforms require Pillow in the Python environment."
            ) from error
        try:
            source = Image.open(io.BytesIO(base64.b64decode(image_base64)))
            source.load()
        except Exception as error:
            raise RuntimeError("Local computer returned an invalid screenshot image.") from error
        image = source.crop(
            (
                source_region["x"],
                source_region["y"],
                source_region["x"] + source_region["width"],
                source_region["y"] + source_region["height"],
            )
        )
        max_width = request["max_raster_width"]
        max_height = request["max_raster_height"]
        if max_width is not None or max_height is not None:
            limit_width = max_width if max_width is not None else image.width
            limit_height = max_height if max_height is not None else image.height
            image.thumbnail((limit_width, limit_height), Image.Resampling.LANCZOS)
        raster_width = image.width
        raster_height = image.height
        output = io.BytesIO()
        if request["format"] == "webp":
            image.save(output, format="WEBP", quality=request["quality"], method=4)
        else:
            image.save(output, format="PNG")
        encoded = output.getvalue()
        image_base64 = base64.b64encode(encoded).decode("ascii")
    return {
        "image_base64": image_base64,
        "width": desktop_width,
        "height": desktop_height,
        "mime_type": "image/webp" if request["format"] == "webp" else "image/png",
        "raster_width": raster_width,
        "raster_height": raster_height,
        "desktop_width": desktop_width,
        "desktop_height": desktop_height,
        "source_region": source_region,
        "dedupe_key": hashlib.sha256(encoded).hexdigest(),
    }


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
        qmp_port = None
        if str(payload.get("image") or "linux").lower() == "linux" and payload.get("vm", True):
            qmp_port = free_tcp_port()
            runtime = QEMURuntime(mode="bare-metal", arch="x86_64", qmp_port=qmp_port)
        sandbox = await Sandbox.create(
            image_for(Image, payload.get("image"), payload.get("vm", True)),
            name=name,
            local=True,
            runtime=runtime,
        )
        if qmp_port is not None:
            from cua_sandbox import sandbox_state

            QMP_PORTS[name] = qmp_port
            sandbox_state.update(name, qmp_port=qmp_port)
        SANDBOXES[name] = sandbox
        return {"sandbox_id": name}
    if operation == "reconnect":
        await connected_sandbox(Sandbox, name)
        return {"sandbox_id": name}
    if operation == "stop":
        await disconnect_sandbox(name)
        repair_qmp_port_for_suspend(name)
        await Sandbox.suspend(name, local=True)
        QMP_PORTS.pop(name, None)
        return {"stopped": True}
    if operation == "destroy":
        await disconnect_sandbox(name)
        await Sandbox.delete(name, local=True)
        QMP_PORTS.pop(name, None)
        return {"destroyed": True}

    sandbox = await connected_sandbox(Sandbox, name)
    try:
        if operation == "observe":
            image = await sandbox.screenshot_base64()
            width, height = await sandbox.get_dimensions()
            return optimized_observation(image, width, height, payload.get("options"))
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
    except Exception:
        await disconnect_sandbox(name)
        raise


async def dispatch(operation, payload):
    name = payload.get("name")
    if not name or operation == "status":
        return await run(operation, payload)
    lock = SANDBOX_LOCKS.setdefault(name, asyncio.Lock())
    async with lock:
        return await run(operation, payload)


async def serve_request(request, write_lock):
    request_id = request.get("id")
    try:
        result = await dispatch(request["operation"], request.get("payload") or {})
        response = {"id": request_id, "result": result}
    except Exception as error:
        response = {"id": request_id, "error": str(error)}
    async with write_lock:
        print(json.dumps(response), flush=True)


async def serve():
    write_lock = asyncio.Lock()
    tasks = set()
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        try:
            request = json.loads(line)
        except Exception as error:
            print(json.dumps({"id": None, "error": str(error)}), flush=True)
            continue
        task = asyncio.create_task(serve_request(request, write_lock))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    await disconnect_all()


async def main():
    operation = sys.argv[1]
    if operation == "serve":
        await serve()
        return
    payload = read_payload()
    try:
        result = await dispatch(operation, payload)
        print(json.dumps(result))
    finally:
        await disconnect_all()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
