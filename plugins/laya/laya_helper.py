#!/usr/bin/env python3
"""Laya sidecar for the Recursive Laya classification plugin.

Two modes share one request handler:

  laya_helper.py serve        newline-delimited JSON over stdin/stdout (spawned by provider.ts)
  laya_helper.py serve-http   tiny HTTP server exposing POST /v1/systemone and GET /v1/health,
                              for running Laya on another machine and pointing the plugin's
                              `baseUrl` setting at it.

Request envelope (stdio):   {"id": 1, "operation": "predict", "payload": {...}}
Response envelope (stdio):  {"id": 1, "result": {...}} | {"id": 1, "error": "..."}

Operations:
  status   -> {"ok", "version", "device", "loaded", "models"}
  warm     -> {"model", "loaded"}                       loads a checkpoint (first call downloads it)
  predict  -> {"model", "answers", "routing", "latency_ms"}  System One wire shape, same as Jev

`predict` payload: {"state": str|dict|list, "questions": {...}, "model": "auto"|name, "lang": code|null}
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time

# torch / transformers / laya print progress and fallback notices to stdout. In stdio mode that
# would corrupt the JSON-lines stream, so responses go to the real stdout and everything else
# is redirected to stderr before any heavy import happens.
_RESPONSE_OUT = sys.stdout
sys.stdout = sys.stderr

_router = None
_router_lock = threading.Lock()
_predict_lock = threading.Lock()
_options = {"device": None, "max_loaded": 1, "preload": False}

AUTO_MODEL = "auto"


def _resolved_device() -> str:
    try:
        import torch
    except ImportError:
        return "unknown"
    if _options["device"]:
        return str(_options["device"])
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def _get_router():
    global _router
    with _router_lock:
        if _router is None:
            import laya

            _router = laya.Router(
                device=_options["device"],
                max_loaded=_options["max_loaded"],
                preload=_options["preload"],
            )
        return _router


def _normalise_model(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == AUTO_MODEL:
        return None
    return text


def op_status(_payload):
    try:
        import laya
    except ImportError as error:
        raise RuntimeError(
            "The laya package is not importable from this Python (%s). Run `pip install laya`." % error
        )
    return {
        "ok": True,
        "version": getattr(laya, "__version__", None),
        "device": _resolved_device(),
        "loaded": list(_router.loaded) if _router is not None else [],
        "models": sorted(laya.DEFAULT_MODELS),
    }


def op_warm(payload):
    router = _get_router()
    model = _normalise_model(payload.get("model")) or router.default
    with _predict_lock:
        router.load(model)
    return {"model": model, "loaded": list(router.loaded)}


def op_predict(payload):
    if "state" not in payload:
        raise ValueError("predict requires a state")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not questions:
        raise ValueError("predict requires a non-empty questions object")
    router = _get_router()
    model = _normalise_model(payload.get("model"))
    lang = payload.get("lang") or None
    started = time.perf_counter()
    with _predict_lock:
        result = router.predict(payload["state"], questions, model=model, lang=lang)
    routing = dict(result.get("routing") or {})
    return {
        "model": routing.get("model"),
        "answers": result.get("answers") or {},
        "routing": routing,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }


OPERATIONS = {"status": op_status, "warm": op_warm, "predict": op_predict}


def handle(operation, payload):
    handler = OPERATIONS.get(operation)
    if handler is None:
        raise ValueError("unknown operation %r" % operation)
    return handler(payload if isinstance(payload, dict) else {})


def _write_response(write_lock, response):
    line = json.dumps(response, ensure_ascii=False)
    with write_lock:
        _RESPONSE_OUT.write(line + "\n")
        _RESPONSE_OUT.flush()


def _serve_one(request, write_lock):
    request_id = request.get("id") if isinstance(request, dict) else None
    try:
        result = handle(request.get("operation"), request.get("payload"))
        _write_response(write_lock, {"id": request_id, "result": result})
    except Exception as error:  # noqa: BLE001 - every failure must reach the caller as JSON
        _write_response(write_lock, {"id": request_id, "error": str(error) or error.__class__.__name__})


def serve_stdio():
    """One worker thread per request; `_predict_lock` serialises model calls, so a slow warm-up
    never blocks `status` from answering."""
    write_lock = threading.Lock()
    workers = []
    while True:
        line = sys.stdin.readline()
        if not line:
            break  # parent closed stdin; answer what is still in flight, then exit
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            _write_response(write_lock, {"id": None, "error": "invalid request: %s" % error})
            continue
        workers = [worker for worker in workers if worker.is_alive()]
        worker = threading.Thread(target=_serve_one, args=(request, write_lock), daemon=True)
        workers.append(worker)
        worker.start()
    for worker in workers:
        worker.join()


def serve_http(host: str, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            if self.path.rstrip("/") in ("/v1/health", "/health"):
                try:
                    self._send(200, op_status({}))
                except Exception as error:  # noqa: BLE001
                    self._send(503, {"ok": False, "error": str(error)})
                return
            self._send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path.rstrip("/") not in ("/v1/systemone", "/systemone"):
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
                if isinstance(payload.get("state"), str):
                    try:
                        payload["state"] = json.loads(payload["state"])
                    except json.JSONDecodeError:
                        pass
                self._send(200, op_predict(payload))
            except ValueError as error:
                self._send(400, {"error": str(error)})
            except Exception as error:  # noqa: BLE001
                self._send(500, {"error": str(error)})

        def log_message(self, fmt, *args):  # keep stderr quiet; stdout is already redirected
            sys.stderr.write("laya-helper: " + (fmt % args) + "\n")

    server = ThreadingHTTPServer((host, port), Handler)
    sys.stderr.write("laya-helper: listening on http://%s:%d\n" % (host, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["serve", "serve-http"])
    parser.add_argument("--device", default=None, help="torch device (cpu, cuda, mps). Default: auto")
    parser.add_argument("--max-loaded", type=int, default=1, help="checkpoints kept resident (LRU)")
    parser.add_argument("--preload", action="store_true", help="load every checkpoint at start")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)

    _options["device"] = args.device or None
    _options["max_loaded"] = max(1, args.max_loaded)
    _options["preload"] = bool(args.preload)

    if args.mode == "serve":
        serve_stdio()
    else:
        serve_http(args.host, args.port)


if __name__ == "__main__":
    main()
