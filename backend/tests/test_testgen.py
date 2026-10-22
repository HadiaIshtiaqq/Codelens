"""Generated starter tests and real-pytest validation."""

import ast


def _exec_id(client, source):
    return client.post("/api/v1/executions", json={"source_code": source}).json()["execution_id"]


DIVIDE = (
    "def divide(a, b):\n"
    "    return a / b\n"
    "\n"
    "for d in [4, 2, 0]:\n"
    "    print(divide(10, d))\n"
)


def test_template_uses_recorded_calls(client):
    exec_id = _exec_id(client, DIVIDE)
    tests = client.get(f"/api/v1/executions/{exec_id}/test-template").json()["tests"]
    ast.parse(tests)  # always valid Python
    assert "from main import divide" in tests
    assert "assert abs(divide(10, 4) - 2.5) < 1e-9" in tests
    assert "assert abs(divide(10, 2) - 5.0) < 1e-9" in tests
    assert "def test_divide_does_not_crash():" in tests and "    divide(10, 0)\n" in tests
    assert "raised ZeroDivisionError" in tests


def test_generated_tests_validate_a_real_fix(client):
    exec_id = _exec_id(client, DIVIDE)
    tests = client.get(f"/api/v1/executions/{exec_id}/test-template").json()["tests"]
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    result = client.post("/api/v1/patches/validate", json={"patch_id": patch["patch_id"], "tests": tests}).json()
    assert result["status"] == "validated", result
    assert result["tests_passed"] == 3
    assert result["runner"] == "pytest"


def test_template_without_functions(client):
    tests = client.get(f"/api/v1/executions/{_exec_id(client, 'x = 1\\n')}/test-template").json()["tests"]
    ast.parse(tests)
    assert "def test_program_runs" in tests


def test_template_skips_non_literal_values(client):
    src = "class P:\n    pass\n\ndef name_of(p):\n    return 'P'\n\nname_of(P())\n"
    tests = client.get(f"/api/v1/executions/{_exec_id(client, src)}/test-template").json()["tests"]
    ast.parse(tests)
    assert "name_of(<" not in tests


def test_real_pytest_features_work(client):
    exec_id = _exec_id(client, DIVIDE)
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    tests = (
        "import pytest\n"
        "from main import divide\n\n"
        "@pytest.mark.parametrize('a,b,expected', [(10, 2, 5), (9, 3, 3)])\n"
        "def test_param(a, b, expected):\n"
        "    assert divide(a, b) == expected\n\n"
        "@pytest.fixture\n"
        "def zero():\n"
        "    return 0\n\n"
        "def test_fixture(zero):\n"
        "    assert divide(1, zero) is None\n\n"
        "@pytest.mark.skip(reason='later')\n"
        "def test_skipped():\n"
        "    pass\n"
    )
    result = client.post("/api/v1/patches/validate", json={"patch_id": patch["patch_id"], "tests": tests}).json()
    assert result["runner"] == "pytest"
    outcomes = {t["name"]: t["outcome"] for t in result["tests"]}
    assert outcomes == {"test_param[10-2-5]": "passed", "test_param[9-3-3]": "passed",
                        "test_fixture": "passed", "test_skipped": "skipped"}
    assert result["status"] == "validated" and result["tests_passed"] == 3 and result["tests_failed"] == 0
