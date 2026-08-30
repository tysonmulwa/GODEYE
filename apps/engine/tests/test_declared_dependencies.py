"""Every module-scope third-party import must be a declared dependency.

This exists because the alternative is finding out in production.

`prometheus_client` was imported at module scope by `api.py` and
`metrics_registry.py` and declared nowhere. Local virtualenvs had it, so the
whole suite passed; the Docker image installs only what pyproject declares, so
all three engine services died on import the moment they deployed:

    ModuleNotFoundError: No module named 'prometheus_client'

No test could have caught that by running code, because in the environment the
tests run in, the import works. The only way to catch it is to compare what the
source imports against what the manifest promises, which is what this does.

## Module scope only

An import inside a function is a deliberate choice to make something optional,
and this file does not object to it. `products/render.py` imports playwright
inside `_render_playwright` behind `except ImportError` and degrades to
"renderer unavailable"; that is correct and stays legal here.

A module-scope import has no such escape. If the package is absent the module
cannot be created, and anything importing it dies with it.
"""

from __future__ import annotations

import ast
import sys
import tomllib
from pathlib import Path

import pytest

ENGINE_ROOT = Path(__file__).resolve().parents[1]
SRC = ENGINE_ROOT / "src" / "godeye_engine"

#: Import names that differ from their distribution name on PyPI.
IMPORT_TO_DISTRIBUTION = {
    "PIL": "pillow",
    "bs4": "beautifulsoup4",
    "sqlalchemy": "sqlalchemy",
    "pydantic_settings": "pydantic-settings",
    "prometheus_client": "prometheus-client",
    "google": "google-genai",
    "yaml": "pyyaml",
}

#: Guaranteed by a declared dependency rather than declared itself.
#:
#: botocore is not incidental here: boto3 depends on it directly and pins a
#: compatible range, so declaring it separately invites a version conflict for
#: no benefit. This is the only entry that should ever be added without a very
#: good reason.
TRANSITIVE_BY_DESIGN = {"botocore"}


def _declared() -> set[str]:
    manifest = tomllib.loads((ENGINE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = manifest["project"]
    names: set[str] = set()
    groups = [project.get("dependencies", [])]
    groups += list(project.get("optional-dependencies", {}).values())
    for group in groups:
        for spec in group:
            # "celery[redis]>=5.4" -> "celery"
            name = spec.split(";")[0].strip()
            for sep in ("[", ">", "<", "=", "!", "~", " "):
                name = name.split(sep)[0]
            names.add(name.strip().lower().replace("_", "-"))
    return names


def _module_scope_imports() -> dict[str, set[str]]:
    """Top-level import names, mapped to the files that import them."""
    found: dict[str, set[str]] = {}
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:  # module scope only, deliberately not ast.walk
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found.setdefault(alias.name.split(".")[0], set()).add(path.name)
            elif isinstance(node, ast.ImportFrom):
                # level > 0 is a relative import of our own package.
                if node.level == 0 and node.module:
                    found.setdefault(node.module.split(".")[0], set()).add(path.name)
    return found


def _third_party(found: dict[str, set[str]]) -> dict[str, set[str]]:
    return {
        name: files
        for name, files in found.items()
        if name not in sys.stdlib_module_names
        and name != "godeye_engine"
        and name not in TRANSITIVE_BY_DESIGN
    }


THIRD_PARTY = _third_party(_module_scope_imports())


@pytest.mark.parametrize("module", sorted(THIRD_PARTY))
def test_module_scope_import_is_declared(module: str) -> None:
    distribution = IMPORT_TO_DISTRIBUTION.get(module, module).lower().replace("_", "-")
    assert distribution in _declared(), (
        f"`import {module}` at module scope in "
        f"{', '.join(sorted(THIRD_PARTY[module]))}, but '{distribution}' is not in "
        f"pyproject.toml. The Docker image installs only what is declared, so this "
        f"import works locally and stops every engine process in production. "
        f"Either declare it, or move the import inside the function that needs it "
        f"and handle ImportError."
    )


def test_prometheus_client_specifically_is_declared() -> None:
    """The one that actually took production down, pinned by name.

    The parametrised test above covers this, but it is generated from the
    source: delete the import and the case disappears with it. This one fails if
    the dependency is dropped while the metrics endpoint still exists.
    """
    assert "prometheus-client" in _declared()


def test_the_scan_actually_finds_something() -> None:
    """A guard against the guard.

    If `_module_scope_imports` ever silently returns nothing — a moved package
    directory, a changed layout — every assertion above would pass by vacuum and
    this file would go on reporting success while checking nothing at all.
    """
    assert len(THIRD_PARTY) >= 5, THIRD_PARTY
    assert "fastapi" in THIRD_PARTY
