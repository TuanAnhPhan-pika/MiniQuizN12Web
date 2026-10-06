# Security consistency review — 2026-10-06

## Existing changes verified

- CORS uses `APP_URL`, comma-separated `CORS_ORIGINS`, known development origins and the existing application/LAN origins. Unknown origins receive no allow headers; their preflight is rejected. Credential responses never use `*`. `Vary: Origin` is also emitted for rejected origins.
- Room join receives account IDs and usernames only from the authenticated server session. Guest-supplied account fields are ignored.
- Multiplayer attempts use `attempt-${room.sessionId}-${player.id}` and PostgreSQL primary-key conflict handling. Answer retries use the unique `(attempt_id, question_index)` constraint.
- Public copies use `getPublicQuizById(id, { includeCorrect: true })` internally and an atomic SQL counter increment instead of rewriting the source quiz. Private, deleted and archived quizzes cannot be fetched by this public helper.
- Player ID and token reads/writes use `sessionStorage` keys suffixed by PIN. Leaving or cancellation removes these keys; removal of obsolete global keys remains for legacy cleanup. Final-page credentials stay until the user leaves, supporting history retries and reconnect on reload. No player-token writes to localStorage, URLs or debug logs were found.

## Additional fixes

- A supplied invalid player token cannot fall back to account matching. Without a token, history matches only server-bound account identity, never a nickname. Attempts use the player's bound account rather than whichever account later submits the token. Guest attempts explicitly have no account ID.
- Reconnect cannot rebind an existing player to a different account.
- History requires a finished room and awaits its archive so the referenced `game_sessions` record exists before inserting the attempt.
- Archive sets `isArchived` only after persistence succeeds. Concurrent callers share the archive promise; failed persistence propagates and remains retryable. Legacy rooms receive one UUID stored back on the room. Room deletion returns an error and preserves the room if archive fails.
- The PG archive transaction now persists `game_players` as well as `game_sessions`; player row IDs derive from the session and player identity so retries and rank changes preserve identity.
- Runtime CRUD defaults to `DATA_BACKEND=pg`; other values fail explicitly. Supabase SDK compatibility code remains unreachable for runtime CRUD; legacy migration imports may still read Supabase. PG failures never switch to REST or local JSON.
- Auth initialization errors propagate to startup. PostgreSQL connections have a 10-second connection timeout. Missing database configuration or failed startup exits with code 1 unless `ALLOW_OFFLINE_MODE=true` is explicitly set. Offline mode is not enabled by these changes.
- Admin permissions use `profiles.role`, including private-quiz read/delete checks. Username `admin` or `system` no longer grants an ownership bypass when updating another user's quiz.
- Default public quiz responses omit both correct indexes and explanations. Explicit internal copies retain answer data.
- History saves check HTTP status and reset their retry guard on failure. The source public copy counter increments after the private quiz save succeeds.
- `npm run lint` now checks every JavaScript file individually; the former multi-file `node --check` command only checked its first file.

## Validation and limits

Run `npm run lint` and `npm test`. Regression tests exercise real local HTTP handlers with isolated auth/database doubles, room token/account binding, invalid-token rejection, nickname isolation, stable attempt retries, concurrent/failed archive retries, public copy routing and counter SQL, public answer redaction, room-scoped storage and initialization failures. A separate real Node process connects to an unreachable local PostgreSQL port and must exit with code 1 before listening.

The database transaction/conflict tests inspect generated SQL with doubles. They do not establish persistence against a live PostgreSQL instance or replace browser testing of final-page reloads and leaving/cancellation. No deployed database was modified during verification.

Private copy creation and counter increment remain two transactions, as in the existing flow. A failure between them can leave a saved private copy with an unchanged counter; fully atomic copy persistence would require a shared transaction across both operations.

UI layout and gameplay are unchanged.


## Delayed reveal and Origin enforcement ? 2026-10-07

- `POST /api/rooms/:pin/answer` now acknowledges `answerAccepted` without `correctChoice`, `isCorrect` or explanations. Server token verification, duplicate prevention, response time, scoring and streak calculation remain authoritative. Internal answer records retain correctness, awarded score, choice, timing and streak for history/archive/statistics.
- New `GET /api/rooms/:pin/result?q=<index>` validates an integer index within question bounds. While running, only `status=started`, `phase=result` and `q=currentQ` allow access. Open, previous and future questions are rejected with 403; malformed/out-of-range indexes return 400. Finished rooms allow review. Responses include correct choice/text, explanation and choice distribution, without tokens or internal answer records.
- Guest room payloads omit the explanation key until finished. Room/status/state/leaderboard/join are sanitized; question statistics remain host-only while answering, and exam statistics remain host-only until finished. Authenticated hosts retain answer access through the existing room/exam-statistics endpoints; role/isHost supplied by clients cannot grant this access.
- Unknown Origin headers now reject POST/PUT/PATCH/DELETE before route execution, as well as OPTIONS. Existing APP_URL/CORS_ORIGINS/development/LAN origins and allowed headers are retained; PATCH is included in allowed methods. Requests without Origin retain compatibility.
- Player UI disables choices and shows the accepted-answer message after submit. Polling `/state` authorizes fetching results; neither client timer expiration nor `allAnswered` reveals answers. Correct/wrong highlighting and explanations occur only after the result API succeeds. Moving to another question clears result state; finished status refreshes review questions and server leaderboard scores. Existing local TEST practice remains separate from real room scoring/reveal.
- Host monitor now sends the existing `/advance` contract (`nextQ`, `phase=question|result`) and uses the existing authenticated `/api/history/hosted` endpoint to finish/archive. Its previous action/qIdx payload did not match the backend contract.

Validation: `npm run lint` and `npm test` pass, including the new HTTP regression covering both correct/incorrect submissions, duplicate rejection, internal scores/records, host authentication, recursive guest response redaction, result gates/index validation, phase transitions, finished review and all mutating Origin methods. Existing account binding, stable IDs, archive retry, PG conflict handling, public-copy, session storage and startup regressions also pass.

`tests/browser-security.js` runs real headless Chrome with two isolated player contexts against production HTTP handlers and isolated auth/database doubles. It verifies accepted-only UI, no reveal after client timer expiry, stale cached answers or allAnswered, guest API denial, both players' result highlights/explanation, hidden answers on next question, and finished panels. No deployed database is used. To rerun, install Playwright outside the repo and set `PLAYWRIGHT_MODULE` to its module path (Chrome is required), then run `node tests/browser-security.js`. This browser check is separate from `npm test` so ordinary security tests do not require a browser installation.

The requested score/total/streak fields remain visible during questions, including on leaderboard APIs. These can imply whether a submitted choice earned points; this change delays the explicit correct answer and explanations, without changing that existing scoring visibility.
