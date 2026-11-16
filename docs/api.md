# Afyazuri API

The machine-readable spec is [openapi.yaml](openapi.yaml) (OpenAPI 3.1). You can load it into any OpenAPI viewer. This page covers the conventions every endpoint follows.

## Basics

- Base path `/api/v1`. JSON in and out, UTF-8.
- **Authentication:** sign in with `POST /api/v1/auth/login`. The response sets two `httpOnly` cookies, `az_at` (access, 10 minutes) and `az_rt` (refresh, path `/api/v1/auth`). Tokens never appear in response bodies. When a request fails with `401 TOKEN_EXPIRED`, call `POST /api/v1/auth/refresh` once and retry. Any other 401 means sign in again.
- **CSRF:** every `POST`/`PUT`/`PATCH`/`DELETE` must send `X-Afyazuri-Client: 1`.
- **Active facility:** most data is scoped to the session's facility. `GET /auth/me` shows it, and `POST /auth/switch-facility` changes it.
- **Permissions:** each route requires one or more permission codes. A missing permission returns `403 FORBIDDEN` with `details.required`. See [permission-matrix.md](permission-matrix.md).

## Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": { "issues": [{ "path": "username", "message": "Required" }] }
  }
}
```

| Status | Typical codes                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `BAD_REQUEST`, `WEAK_PASSWORD` (`details.problems`), `INVALID_TOTP`                                            |
| 401    | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `SESSION_IDLE`, `SESSION_ENDED`, `REFRESH_TOKEN_REUSED`, `INVALID_CREDENTIALS`, `MFA_REQUIRED` |
| 403    | `FORBIDDEN`, `CSRF_HEADER_MISSING`, `PASSWORD_CHANGE_REQUIRED`, `MFA_ENROLMENT_REQUIRED`, `ACCOUNT_DISABLED`                       |
| 404    | `NOT_FOUND` (also returned for records in another facility)                                                                        |
| 409    | `CONFLICT`, `USERNAME_TAKEN`, `IMMUTABLE_RECORD`, `REQUEST_IN_PROGRESS`                                                            |
| 422    | `IDEMPOTENCY_KEY_REUSED`                                                                                                           |
| 423    | `ACCOUNT_LOCKED` (`details.lockedUntil`)                                                                                           |
| 429    | `RATE_LIMITED` (sign-in and refresh)                                                                                               |

## Pagination

List endpoints use cursor pagination: `?limit=25&cursor=<opaque>`. Responses look like `{ "data": [...], "nextCursor": "…" | null }`. Pass `nextCursor` back unchanged to get the next page.

## Idempotency

Send `Idempotency-Key: <8–100 URL-safe chars>` on retryable writes. The first response is stored for 7 days, and repeats return it with `Idempotent-Replay: true`. Reusing a key with a different body returns `422`. Phase 1 accepts it on `POST /users`. From Phase 3 it is **required** for payments, dispensing, claim submission and offline-synced writes.

## Operational endpoints (no `/api/v1` prefix)

| Path           | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `GET /health`  | Liveness, `{ "status": "ok" }`                           |
| `GET /ready`   | Database reachable and migrations applied, otherwise 503 |
| `GET /metrics` | Prometheus text format. Keep it off public networks.     |
