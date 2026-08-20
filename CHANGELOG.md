# Changelog

## 0.7.1 - 2026-08-20

### Fixed

- Driver connection configs are handed to Bun's SQL client as-is instead of
  being assembled into a URL first, so usernames and passwords containing `/`,
  `?`, `#`, `@` or `%` no longer produce an `Invalid URL` error. The `url`
  connection form still requires percent-encoded credentials.
- Driver configs no longer force `host` to `localhost` while leaving `port`,
  `database`, `username`, and `password` to be resolved from the environment.
  All five fields now behave alike: whatever you omit is resolved by Bun from
  the adapter's standard variables (`PGHOST`, `PGPORT`, `PGUSER`, ... and the
  `MYSQL_*` equivalents), falling back to `localhost` and the default port when
  unset. Previously an environment that supplied credentials and port would
  still be pointed at `localhost`. Pass `host` explicitly to override the
  environment; see `docs/configuration.md` for the full contract.

## 0.7.0 - 2026-08-19

### Changed

- Model hydration and serialization avoid redundant Proxy work, visibility
  rebuilding, and no-op cast dispatch. `DB.table()` is documented as the
  plain-row path for read-only endpoints that do not need model behavior.

### Fixed

- In-place mutations to `date` and `datetime` casts are detected by dirty
  tracking and persisted without corrupting the original database snapshot.
- Hydration preserves `setConnection` overrides declared either as prototype
  methods or instance fields, while retaining the direct fast path for the
  default implementation.
- Mutable-cast metadata remains isolated from later changes to a model's public
  static cast map.

## 0.6.5 - 2026-08-19

### Breaking changes

- SQLite connections now enable `PRAGMA foreign_keys=ON` by default. Run
  `PRAGMA foreign_key_check` before upgrading an existing database. Set
  `sqlitePragmas: { foreignKeys: false }` temporarily only when legacy data
  must be repaired first.
- The misleading `encrypted` cast was removed. Use `base64` for encoding or a
  custom cast backed by a real cipher for encryption.
- `decimal:N` now rounds decimal strings without converting through
  JavaScript `number` and throws for invalid values or scales. Recomputed
  values can therefore differ from earlier binary-floating-point rounding.
- `sum()` and `avg()` preserve exact driver values and return
  `number | string | bigint`; callers must not assume a `number`.
- Saving an existing model without its primary key now throws instead of
  issuing an unsafe update. Textual primary keys are generated only when the
  model and database schema indicate that Bunny owns their generation.

### Changed

- Write payloads omit `undefined` properties so database defaults run, while
  explicit `null` values still write SQL `NULL`.
- MySQL date writes require a UTC session and verify it on the same physical
  connection as the write. The successful check is reused while a transaction
  pins that session.
- Foreign-key actions are normalized and restricted to supported SQL actions;
  `SET NULL` is rejected when a non-nullable local column is visible in the
  current blueprint.

### Fixed

- Pagination counts now preserve joins and correctly wrap grouped, distinct,
  `HAVING`, union, and recursive queries.
- Manual MySQL transactions keep `BEGIN`, writes, and commit or rollback on one
  pooled session, and reserved sessions are released on error paths.
- SQLite, MySQL, and PostgreSQL now share regression coverage for defaults,
  pagination, foreign-key actions, raw bindings, migrations, and native value
  contracts.
