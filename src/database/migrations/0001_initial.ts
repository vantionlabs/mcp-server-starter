import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient;

  // Credentials for services and scripts that cannot sign in through the identity
  // provider.
  yield* sql`
    create table api_keys (
      id text primary key,
      name text not null,
      -- Who the key acts as. Shows up as the subject in the audit log, so pick
      -- something a person can trace, like "svc:billing-sync".
      subject text not null,
      scopes text[] not null default '{}',
      -- SHA-256 of the key. A copy of this table must not be a set of working
      -- credentials. Unsalted on purpose: keys are 32 random bytes, so there is
      -- no dictionary to attack.
      hash text not null unique,
      -- The last characters of the key, so a leaked key can be matched to its row.
      hint text not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )
  `;

  // One row per tool call, including calls that were refused.
  yield* sql`
    create table audit_log (
      id bigint generated always as identity primary key,
      occurred_at timestamptz not null default now(),
      subject text not null,
      principal_kind text not null,
      credential_id text not null,
      client_name text,
      tool text not null,
      arguments jsonb not null,
      outcome text not null check (outcome in ('ok', 'denied', 'rate_limited', 'failed')),
      error text,
      duration_ms integer not null
    )
  `;
  yield* sql`create index audit_log_subject_occurred_at on audit_log (subject, occurred_at desc)`;
  yield* sql`create index audit_log_tool_occurred_at on audit_log (tool, occurred_at desc)`;
});
