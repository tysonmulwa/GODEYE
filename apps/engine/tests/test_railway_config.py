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


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_pre_deploy_command_is_declared_and_empty(path: Path):
    """Declared, not merely cleared in the dashboard.

    Railway's rule is that "configuration defined in code will always override
    values from the dashboard" -- but only for fields the code actually names.
    An undeclared field falls back to the dashboard value, and a redeploy
    inherits the old manifest wholesale. So clearing this in the UI fixes one
    service until the next redeploy; declaring it here is what makes it stay.

    It has to be empty. A pre-deploy command that hangs rather than fails holds
    the deployment slot, and every other service then sits at "Waiting for
    deployment slot" -- including the deploy that would fix it. That is the
    state the whole project was wedged in: five services queued behind a
    pre-deploy that could never finish.

    Emptiness costs nothing here because migrations are deliberate and
    expand-only (docs/DEPLOYMENT.md): they are applied before the code that
    needs them, old code ignores new columns, and so a deploy never has to
    migrate in order to succeed.
    """
    deploy = json.loads(path.read_text(encoding="utf-8")).get("deploy", {})
    assert "preDeployCommand" in deploy, (
        f"{path.relative_to(REPO_ROOT)} does not declare preDeployCommand, so "
        f"Railway falls back to whatever is set in the dashboard and every "
        f"redeploy inherits it"
    )
    command = deploy["preDeployCommand"]
    assert command in ([], None, ""), (
        f"{path.relative_to(REPO_ROOT)} sets preDeployCommand to {command!r}. "
        f"If a pre-deploy is genuinely needed, it must be non-interactive and "
        f"must fail rather than hang: `prisma migrate dev` prompts for input a "
        f"container cannot give, and waits forever holding the slot."
    )
