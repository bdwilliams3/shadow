from shadow_fixture import greeting


def test_default_greeting() -> None:
    assert greeting() == "Hello, world."
