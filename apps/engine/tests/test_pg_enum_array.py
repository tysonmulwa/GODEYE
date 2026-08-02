"""Decoding a Prisma enum array, e.g. "Platform"[].

Autopilot never produced a post. PostingPlan.platforms was mapped as
ARRAY(String), but the column is an array of a Prisma-owned enum, which psycopg
returns as the raw literal '{FACEBOOK,TIKTOK}'. SQLAlchemy then treated that
string as the sequence and every index gave one character, so platforms[0] was
'{'. Nothing raised until a query cast '{' to Platform and killed the run.

The failure is quiet, which is what makes it worth testing directly.
"""

import pytest

from godeye_engine.db import PgEnumArray, PostingPlan, parse_pg_array


class TestParsing:
    @pytest.mark.parametrize(
        "literal,expected",
        [
            ("{FACEBOOK,TIKTOK,TELEGRAM}", ["FACEBOOK", "TIKTOK", "TELEGRAM"]),
            ("{FACEBOOK}", ["FACEBOOK"]),
            ("{}", []),
            ('{"WITH,COMMA",PLAIN}', ["WITH,COMMA", "PLAIN"]),
        ],
    )
    def test_literals(self, literal, expected):
        assert parse_pg_array(literal) == expected

    def test_a_single_platform_does_not_become_its_letters(self):
        """The whole bug in one line: 'FACEBOOK'[0] is 'F'."""
        assert parse_pg_array("{FACEBOOK}")[0] == "FACEBOOK"


class TestTypeDecorator:
    def setup_method(self):
        self.column = PgEnumArray("Platform")

    def test_a_literal_from_the_driver_becomes_a_list(self):
        assert self.column.process_result_value("{FACEBOOK,TIKTOK}", None) == [
            "FACEBOOK",
            "TIKTOK",
        ]

    def test_a_driver_that_already_decoded_is_left_alone(self):
        """psycopg returns a list once the enum type is registered; re-parsing
        that would be wrong."""
        assert self.column.process_result_value(["FACEBOOK"], None) == ["FACEBOOK"]

    def test_null_survives(self):
        assert self.column.process_result_value(None, None) is None

    def test_a_list_is_sent_as_an_array_literal(self):
        assert self.column.process_bind_param(["FACEBOOK", "X"], None) == "{FACEBOOK,X}"

    def test_an_empty_list_is_an_empty_array(self):
        assert self.column.process_bind_param([], None) == "{}"


def test_the_platforms_column_uses_it():
    """ARRAY(String) here is what caused the outage; it must not come back."""
    assert isinstance(PostingPlan.c.platforms.type, PgEnumArray)
