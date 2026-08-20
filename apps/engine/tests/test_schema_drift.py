"""The engine's table definitions must match the schema Prisma owns.

Two services describe the same Postgres tables in two languages. Prisma owns
them -- it writes the migrations -- and ``db.py`` restates them in SQLAlchemy
Core so the worker can read and write without a Node process in the loop.

Nothing checked that the two agreed, and the failure mode is quiet and slow. A
Prisma rename ships a migration, CI goes green because every test in both
suites uses its own language's definition, and the break surfaces later as a
Celery task raising ``UndefinedColumn`` against a table that "obviously"
exists -- inside a retry, on a worker, in a log nobody is reading. The
scheduled posts simply stop going out.

This is the drift test the scorecard lists as missing under Migrations. It
parses the Prisma schema as text rather than shelling out to ``prisma`` so it
runs in the Python suite with no Node toolchain, which is the only way it gets
run often enough to be worth having.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import Table

from godeye_engine import db as engine_db

SCHEMA = Path(__file__).resolve().parents[3] / "packages" / "db" / "prisma" / "schema.prisma"

#: Prisma scalars, so relation fields can be told apart from columns. A
#: relation field is not a column -- it is Prisma's view of a foreign key that
#: lives on one side or the other -- and treating one as a column would make
#: this test demand columns that cannot exist.
SCALARS = {
    "String",
    "Boolean",
    "Int",
    "BigInt",
    "Float",
    "Decimal",
    "DateTime",
    "Json",
    "Bytes",
}


def _enums(text: str) -> set[str]:
    return set(re.findall(r"^enum\s+(\w+)\s*\{", text, re.MULTILINE))


def _strip_comments(line: str) -> str:
    """Drop `//` and `///` trailing comments without touching a `//` inside a string."""
    in_string = False
    for i, char in enumerate(line):
        if char == '"':
            in_string = not in_string
        elif char == "/" and not in_string and line[i : i + 2] == "//":
            return line[:i]
    return line


def _parse_models(text: str) -> dict[str, dict[str, dict[str, object]]]:
    """`{model: {column: {"optional": bool, "type": str}}}`, columns only."""
    enums = _enums(text)
    models: dict[str, dict[str, dict[str, object]]] = {}

    for match in re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", text, re.MULTILINE | re.DOTALL):
        name, body = match.group(1), match.group(2)
        columns: dict[str, dict[str, object]] = {}

        for raw in body.splitlines():
            line = _strip_comments(raw).strip()
            if not line or line.startswith("@@") or line.startswith("///"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            field, declared = parts[0], parts[1]

            # `Model[]` is a relation. `String[]` is NOT -- it is a Postgres
            # array column (text[]), and treating the two the same made this
            # test pass over five real columns on BusinessProfile alone.
            base = declared.rstrip("?").removesuffix("[]")
            if base not in SCALARS and base not in enums:
                continue  # a relation field, e.g. `org Organization @relation(...)`

            # Prisma allows a column name that differs from the field name.
            mapped = re.search(r'@map\("([^"]+)"\)', line)
            column = mapped.group(1) if mapped else field
            columns[column] = {
                "optional": declared.endswith("?"),
                "type": base,
                # An array column is never NULL in Prisma -- it defaults to [].
                "array": declared.endswith("[]"),
            }

        # And a table name that differs from the model name.
        table = re.search(r'@@map\("([^"]+)"\)', body)
        models[table.group(1) if table else name] = columns

    return models


@pytest.fixture(scope="module")
def prisma_models() -> dict[str, dict[str, dict[str, object]]]:
    assert SCHEMA.exists(), f"Prisma schema not found at {SCHEMA}"
    return _parse_models(SCHEMA.read_text(encoding="utf-8"))


def engine_tables() -> list[Table]:
    """Every ``Table`` the engine declares, found by inspection rather than a list.

    A hand-maintained list is the thing this test exists to replace: a new
    table added to ``db.py`` and forgotten here would be exactly the drift
    nobody notices.
    """
    return [
        value
        for value in vars(engine_db).values()
        if isinstance(value, Table)
    ]


def test_the_parser_actually_found_something(prisma_models):
    """A parser that silently matches nothing turns this whole file green."""
    assert len(prisma_models) > 15
    assert "ScheduledPost" in prisma_models
    assert "scheduledAt" in prisma_models["ScheduledPost"]
    # A relation field must NOT have been read as a column.
    assert "org" not in prisma_models["ScheduledPost"]
    assert "contentItem" not in prisma_models["ScheduledPost"]


def test_engine_declares_tables():
    assert len(engine_tables()) > 10


@pytest.mark.parametrize("table", engine_tables(), ids=lambda t: t.name)
def test_table_exists_in_prisma(table: Table, prisma_models):
    """The engine reads a table Prisma does not create -> every query fails."""
    assert table.name in prisma_models, (
        f"{table.name} is declared in db.py and is not in schema.prisma. "
        f"Either Prisma renamed or dropped it, or the engine invented it."
    )


@pytest.mark.parametrize("table", engine_tables(), ids=lambda t: t.name)
def test_columns_exist_in_prisma(table: Table, prisma_models):
    """The column-level half, which is where drift actually happens.

    A dropped or renamed column is a migration that succeeds and a worker that
    starts raising UndefinedColumn on its next tick.
    """
    known = prisma_models.get(table.name, {})
    missing = [c.name for c in table.columns if c.name not in known]
    assert not missing, (
        f"{table.name} declares {missing} in db.py, and schema.prisma has no such column. "
        f"Prisma owns the migrations, so the engine is the side that is wrong."
    )


@pytest.mark.parametrize("table", engine_tables(), ids=lambda t: t.name)
def test_nullability_agrees(table: Table, prisma_models):
    """A column Prisma allows to be null must not be NOT NULL here.

    This direction only. The engine deliberately omits columns it never touches
    and does not restate every constraint, so "Prisma required, engine
    optional" is normal. The reverse is a real defect: the engine would treat a
    NULL it can genuinely receive as impossible, and the row it builds from it
    would carry None into code that never checks.
    """
    known = prisma_models.get(table.name, {})
    wrong = [
        c.name
        for c in table.columns
        if c.name in known and known[c.name]["optional"] and not c.nullable and not c.primary_key
    ]
    assert not wrong, (
        f"{table.name}.{wrong} is optional in schema.prisma and NOT NULL in db.py. "
        f"The engine will treat a NULL it can really receive as impossible."
    )


def test_no_table_is_declared_twice():
    names = [t.name for t in engine_tables()]
    assert len(names) == len(set(names)), f"duplicate Table() definitions: {names}"
