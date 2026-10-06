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
