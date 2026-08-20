"""Dev runner, starts FastAPI, the Celery worker, and Celery Beat together.

Usage:  python -m godeye_engine.run
(Windows note: the worker uses --pool=solo, required for Celery on Windows.)
"""

from __future__ import annotations

import subprocess
import sys
import time

from .config import get_settings, validate_config
from .telemetry import configure_logging

PROCESSES: list[tuple[str, list[str]]] = [
    (
        "api",
        [
            sys.executable, "-m", "uvicorn", "godeye_engine.api:app",
            "--host", "0.0.0.0", "--port", str(get_settings().engine_port),
        ],
    ),
    (
        "worker",
        [
            sys.executable, "-m", "celery", "-A", "godeye_engine.celery_app", "worker",
            "--loglevel=info", "--pool=solo",
        ],
    ),
    (
        "beat",
        [
            sys.executable, "-m", "celery", "-A", "godeye_engine.celery_app", "beat",
            "--loglevel=info",
        ],
    ),
]


def main() -> None:
    # Fail the boot, not the first request that happens to need a secret.
    validate_config()
    configure_logging()
    children: list[subprocess.Popen] = []
    try:
        for name, cmd in PROCESSES:
            print(f"[godeye-engine] starting {name}: {' '.join(cmd)}")
            children.append(subprocess.Popen(cmd))
        # Exit if any child dies; Ctrl+C tears everything down.
        while True:
            for child in children:
                code = child.poll()
                if code is not None:
                    print(f"[godeye-engine] a process exited with code {code}; shutting down")
                    raise KeyboardInterrupt
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    main()
