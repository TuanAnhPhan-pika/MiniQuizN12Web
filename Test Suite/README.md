# MiniQuiz Test Suite

Vietnamese guide: [Phân loại test, luồng chạy, nhánh điều kiện và mức đồng thời](HUONG_DAN_KIEM_THU.md).

Requires Node.js 22.17+ and `npm install` (or `npm ci` once the lockfile is committed).

## Run from the project root

| Command | Scope |
| --- | --- |
| `npm run test:suite` | Existing automated tests plus the new suites; no external database |
| `npm run test:backend` | Authentication, API, room management, AI, database adapters and migration fixtures |
| `npm run test:frontend` | DOM behavior in jsdom, browser storage, auth, editor, dashboard, waiting rooms and importer |
| `npm run test:performance` | Local concurrency and resilience tests in `performance/` |
| `npm run test:resilience` | Compatibility alias for `test:performance` |
| `npm run test:database` | Real PostgreSQL integration, isolated schema and rollback |
| `npm run test:coverage` | Generate coverage without enforcing thresholds |
| `npm run test:coverage:check` | Run tests and fail if the configured coverage gate is missed |
| `npm run test:coverage:database` | Merge local and isolated PostgreSQL coverage, then enforce the gate; requires `TEST_DATABASE_URL` |

Open `Test Suite/reports/coverage/index.html` for the HTML report. JSON and LCOV reports are in the same directory. Generated reports are ignored by Git.

All test code is contained in `Test Suite/`: `backend/`, `frontend/`, `performance/`, `database/` and optional `browser/` scripts. `helpers/` contains harnesses; `fixtures/` contains the login database utility and SQL seed/reset scripts; `RESULTS.md` contains the latest consolidated result; `evidence/` contains regenerated browser evidence (ignored by Git). `npm test` now runs the same complete local suite as `npm run test:suite`. Browser scripts and PostgreSQL tests are opt-in and are not run by the default suite. Run a single file with `node --test "Test Suite/frontend/storage.test.cjs"`.

The browser scripts run standalone against local servers: `browser-login.js --mock` uses Chrome DevTools directly; `browser-security.js` uses Playwright with installed Chrome. Both were rerun for the latest report. The fixtures utility can modify the database it is configured to use; it is not the isolated PostgreSQL runner. No k6 tests have been installed or run.

## Coverage scope and target

All first-party JavaScript in `src/` and `public/js/` is included, including unexecuted files. Third-party `*.min.js`, test files and dependencies are not included. Nothing is excluded merely because it is hard to test.

Targets: **80% statements, lines, functions and branches**. This is a project-specific gate, not a claim of an industry standard. Google describes 60/75/90% as acceptable/commendable/exemplary and cautions against treating coverage as proof of correctness. Sonar's default 80% condition applies to new code.

- https://testing.googleblog.com/2020/08/code-coverage-best-practices.html
- https://docs.sonarsource.com/sonarqube-community-build/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates

Coverage uses V8 through c8. Existing tests sometimes load source through `vm` with appended exports; interpret per-file figures alongside their assertions. This suite does not claim real browser rendering coverage: jsdom provides DOM behavior, not layout or browser E2E.

## Real PostgreSQL

Set `TEST_DATABASE_URL` in the current shell, then run `npm run test:database`. Credentials are never committed. This command does not use `DATABASE_URL` as an implicit production default.

The preload creates a random schema inside an outer transaction. SQL uses that schema alone, operations use nested savepoints, and teardown rolls back the entire schema and all fixtures. This validates SQL against PostgreSQL but does not test connection pooling or concurrent transactions; the existing unit suites cover pool behavior separately.

Run database integration through this runner, not by enabling `RUN_DB_TESTS` on the old direct command: the runner installs the isolation harness. These commands never target the deployed web URL or run load tests against production.
