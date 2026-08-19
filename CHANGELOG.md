# Changelog

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
