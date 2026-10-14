---
name: python
description: Company standard for Python - supported versions, uv/poetry/pip with lockfiles and virtual environments, pyproject.toml, Ruff lint and format, type hints with mypy/pyright, pydantic validation, logging, exceptions, async, FastAPI/Django/Flask security, packaging, pytest testing, data and scripting hygiene, and dependency auditing. Use when writing, reviewing or debugging Python services, scripts, data jobs or Lambda/Cloud Functions code.
---

# Python

Load `engineering-guardrails`, `secure-coding` and `code-fundamentals` first.

## 1. Project baseline

- Supported CPython (check `python --version`; pin in `.python-version`, `pyproject.toml` `requires-python`, Dockerfile).
- Always a virtual environment; never `sudo pip install` or install into the system interpreter (`pip install --break-system-packages` only in throwaway containers).
- Dependency manager: follow the repo (`uv.lock` → uv, `poetry.lock` → poetry, `requirements*.txt` → pip-tools/pip). New projects: **uv**.

```bash
uv sync --frozen               # install exactly the lockfile
uv add httpx                   # add + lock
uv run pytest -q
```

- `pyproject.toml` holds tool config:

```toml
[tool.ruff]
line-length = 100
target-version = "py312"
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "S", "SIM", "RUF", "PL", "N"]   # S = bandit security rules
[tool.mypy]
strict = true
[tool.pytest.ini_options]
addopts = "-q --strict-markers"
```

## 2. Code rules

- Type hints everywhere; `mypy --strict` or `pyright` in CI; `typing.Protocol` for interfaces.
- Validate external data with **pydantic** v2 models (requests, env via `pydantic-settings`, files, API responses).
- Exceptions: raise specific exceptions with context (`raise OrderError(...) from exc`); never bare `except:`; never `except Exception: pass`.
- Logging: `logging` (or `structlog`) with module loggers, JSON in services, no `print` in libraries; never log secrets/PII.
- Paths with `pathlib`; files with context managers; encodings explicit (`encoding="utf-8"`).
- Dates: timezone-aware `datetime` (`datetime.now(tz=UTC)`); money with `decimal.Decimal`.
- Subprocess: `subprocess.run([...], check=True, timeout=...)`, never `shell=True` with input.
- Serialization: JSON; `yaml.safe_load`; never `pickle`/`marshal`/`shelve` on untrusted data; never `eval`/`exec`.
- Async (`asyncio`): don't call blocking I/O in async code (use `asyncio.to_thread` or async libs: `httpx`, `asyncpg`); always set timeouts.
- HTTP clients: `httpx`/`requests` with explicit `timeout=`; `verify=True` always.
- SQL: parameterised (`cursor.execute("... where id = %s", (id,))`), SQLAlchemy 2.0 style; migrations with Alembic (`db-migrations`).

## 3. Frameworks

- **FastAPI**: pydantic models for request/response, dependencies for auth, `HTTPException` with safe messages, CORS allow-list, run with `uvicorn`/`gunicorn -k uvicorn.workers.UvicornWorker`, disable docs in prod if not public.
- **Django**: `DEBUG=False`, `ALLOWED_HOSTS` set, `SECRET_KEY` from secret manager, `SECURE_*` settings (`SECURE_SSL_REDIRECT`, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, HSTS), ORM queries (no `raw()`/`extra()` with input), `python manage.py check --deploy` clean.
- **Flask**: `flask-talisman` for headers, `flask-wtf` CSRF, Jinja autoescape on, never `debug=True` in prod.

## 4. Testing

```bash
uv run pytest -q -x --maxfail=1          # compact output, stop early (cheaper for agents)
uv run pytest -q --cov=src --cov-report=term-missing:skip-covered
uv run ruff check . && uv run ruff format --check . && uv run mypy src
```

- pytest fixtures, `pytest.mark.parametrize`, `freezegun`/`time-machine` for time, `respx`/`responses` for HTTP mocks, Testcontainers for real databases.
- Large outputs are trimmed by the `token-saver` hook; the full log path is printed when needed.

## 5. Scripts and data jobs

- `argparse`/`typer` CLIs with `--dry-run` for anything that changes data; log what would change.
- Process large files streaming (iterators, `csv` module, pandas `chunksize`, polars lazy); do not load multi-GB files into memory.
- Never print DataFrames containing personal data into the transcript; show `df.shape`, `df.dtypes`, aggregates, or masked samples.

## 6. Security and supply chain

```bash
uv run pip-audit                 # or: pip-audit -r requirements.txt
uv run bandit -q -r src          # if not using ruff S rules
```

- Hash-pinned requirements for deployments (`uv export --format requirements-txt` includes hashes; or `pip-compile --generate-hashes`).
- Verify package names (typosquatting is common on PyPI); prefer well-maintained packages.
- Publishing to PyPI/internal indexes happens from CI with trusted publishing (OIDC), not from an agent (guard asks).

## Definition of done

Follow `code-fundamentals`. For Python that means:

```bash
uv run ruff format --check . && uv run ruff check . && uv run mypy src
uv run pytest -q --cov=src --cov-branch --cov-fail-under=80
```

- Every new or changed function with logic gets pytest tests: happy path, boundaries, invalid input and the exception path (`with pytest.raises(OrderError, match="expired")`).
- Errors: catch specific exceptions where you can act, re-raise with context (`raise ... from exc`), clean up with `with`/`finally`; services convert domain errors to HTTP responses in one exception handler.

```python
def load_order(order_id: str) -> Order:
    try:
        row = repo.get(order_id)
    except DatabaseError as exc:
        raise OrderStoreError(f"load order {order_id}") from exc
    if row is None:
        raise OrderNotFound(order_id)
    return Order.model_validate(row)
```

## Never

- `eval`/`exec`/`pickle.loads`/`yaml.load` on untrusted data, `shell=True` with input, `verify=False`.
- Install into the system Python, or commit virtualenvs, `__pycache__`, `.env`.
- Bare `except:`, silent exception swallowing, or `print` debugging left in services.
- Dump personal data from DataFrames or query results into chat.
- Add logic without a unit test that covers its error path, skip or weaken a failing test to get green, or swallow errors (see `code-fundamentals`).
