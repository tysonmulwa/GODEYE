"""The deploy configs have to parse, or nothing deploys.

Written after `apps/engine/railway.beat.json` reached main containing:

    "startCommand": "startCommand": "celery -A godeye_engine.celery_app beat ...",

which is not JSON. Railway could not read the config, engine-beat failed to
deploy, and a failing service holds the project's deployment slot -- so
engine-worker, engine-api and the API all sat in "Queued" behind it. One
unparseable file stopped the entire project from shipping.

Two things made it survive:

* It arrived in a commit titled "Fix syntax error in railway.beat.json", the
  second of two hand edits attempting the same repair. Nothing between the
  editor and production reads these files.
* A `json.load()` spot check is not enough on its own. It accepts duplicate
  keys silently, keeping the last one, so `{"a": 1, "a": 2}` passes while
  meaning something different from what was written. This checks for that too.

The `exec` prefix assertion records a separate outage with the same shape:
Railway's Dockerfile builder runs `startCommand` directly as PID 1 with no
shell, so `exec celery ...` makes it look for a binary named `exec` and the
container dies at startup with "The executable `exec` could not be found".
`exec` is a shell builtin, and it is redundant here anyway -- being PID 1 is
what it would have bought, and this builder already gives it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

#: Every Railway service config in the repo. Deployment configs are a
#: repo-level concern: a broken one in any service blocks the others.
CONFIGS = sorted(REPO_ROOT.glob("apps/*/railway*.json"))


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """`json.loads` hook that refuses what the default parser would swallow."""
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise ValueError(f"duplicate key {key!r}")
        seen.add(key)
    return dict(pairs)


def test_the_configs_were_actually_found():
    """A glob that matches nothing makes every parametrised test below vacuous,
    which is the failure mode where the suite is green and unprotective."""
    assert CONFIGS, f"no railway*.json found under {REPO_ROOT / 'apps'}"
    names = {path.name for path in CONFIGS}
    # The three that exist today. A new one is picked up automatically; these
    # disappearing means a service lost its config.
    assert {"railway.json", "railway.worker.json", "railway.beat.json"} <= names


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: str(p.relative_to(REPO_ROOT)))
class TestEveryConfig:
    def test_parses_as_json(self, path: Path):
        """The bug. Railway reads these itself, so an unparseable file is not a
        build error you can see -- it is a service that will not start."""
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            pytest.fail(f"{path.relative_to(REPO_ROOT)} is not valid JSON: {e}")

    def test_has_no_duplicate_keys(self, path: Path):
        """Valid JSON can still be wrong JSON. The default parser keeps the last
        of a repeated key without complaining, so a hand edit that leaves two
        `startCommand`s silently ships whichever came second."""
        try:
            json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
        except ValueError as e:
            pytest.fail(f"{path.relative_to(REPO_ROOT)}: {e}")

    def test_start_command_is_a_real_binary(self, path: Path):
        """No shell runs this line, so the first token has to exist on PATH."""
        command = json.loads(path.read_text(encoding="utf-8")).get("deploy", {}).get(
            "startCommand", ""
        )
        if not command:
            pytest.skip("no startCommand; this service uses the image's CMD")
        first = command.split()[0]
        assert first != "exec", (
            f"{path.relative_to(REPO_ROOT)}: `exec` is a shell builtin, and the "
            f"Dockerfile builder runs this with no shell. The container will die "
            f"with \"The executable `exec` could not be found\"."
        )
        assert not first.startswith(("&&", "|", ";")), f"{first!r} needs a shell that is not there"


class TestTheQueueRoutingSurvives:
    """The worker's `-Q` list is deployment config, and losing it is silent.

    Without it the worker consumes only `task_default_queue`, so everything
    routed to `publish` is accepted by the broker and never delivered: no error,
    no retry, no dead letter. Posts sat "pending" for weeks. Asserted here
    because it lives in this file, not in the code the other tests cover.
    """

    def test_worker_subscribes_to_every_routed_queue(self):
        from godeye_engine.celery_app import REQUIRED_QUEUES

        config = json.loads(
            (REPO_ROOT / "apps/engine/railway.worker.json").read_text(encoding="utf-8")
        )
        command = config["deploy"]["startCommand"].split()
        assert "-Q" in command, "worker has no -Q: it will consume the default queue only"
        subscribed = set(command[command.index("-Q") + 1].split(","))
        assert REQUIRED_QUEUES <= subscribed, (
            f"worker does not consume {sorted(REQUIRED_QUEUES - subscribed)}; "
            f"tasks routed there queue up forever"
        )

    def test_beat_schedules_and_the_worker_does_not(self):
        """Exactly one scheduler. `worker --beat` alongside a beat service fires
        every periodic task twice; periodic_lock.py makes that harmless rather
        than intended."""
        beat = json.loads(
            (REPO_ROOT / "apps/engine/railway.beat.json").read_text(encoding="utf-8")
        )["deploy"]["startCommand"]
        worker = json.loads(
            (REPO_ROOT / "apps/engine/railway.worker.json").read_text(encoding="utf-8")
        )["deploy"]["startCommand"]

        assert " beat " in f" {beat} ", "the beat service does not run beat"
        assert "--beat" not in worker, "worker runs its own scheduler: that is two beats"


class TestPreDeployCommandTerminates:
    """A pre-deploy command that never exits stops the whole environment.

    `engine-worker` had one, set in the Railway dashboard: the Celery worker
    itself. A pre-deploy command has to EXIT before Railway starts the real
    process, and a Celery worker does not, so every deploy stopped there and sat
    in "Deploying" with the container up. A deployment stuck in a non-terminal
    state holds the environment's deploy slot, so the API, the engine and beat
    all queued behind it and nothing shipped for most of a day.

    That value lived only in Railway's settings, so nothing here could have seen
    it -- `scripts/railway-drift.mjs` is what asks Railway. This covers the half
    that is in the repo: the same command arriving through a config file, which
    is a diff away and would fail in exactly the same silent shape.
    """

    #: First tokens of processes that run until they are killed.
    NEVER_EXITS = ("celery", "uvicorn", "gunicorn")

    @pytest.mark.parametrize("path", CONFIGS, ids=lambda p: str(p.relative_to(REPO_ROOT)))
    def test_pre_deploy_command_is_not_a_server(self, path: Path):
        deploy = json.loads(path.read_text(encoding="utf-8")).get("deploy", {})
        commands = deploy.get("preDeployCommand") or []
        if isinstance(commands, str):
            commands = [commands]
        for command in commands:
            first = command.split()[0] if command.split() else ""
            assert first not in self.NEVER_EXITS, (
                f"{path.relative_to(REPO_ROOT)}: preDeployCommand starts {first!r}, which "
                f"runs until killed. The deploy will never finish, and it takes every "
                f"other service in the environment down with it. A pre-deploy command is "
                f"for a migration -- something that ends."
            )
