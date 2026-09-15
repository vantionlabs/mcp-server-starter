# Contributing

Thanks for helping. This is a starter people fork and own, so the bar for a
change is: does it make the default better for most forks, without adding a
service or a concept they have to learn?

## Good contributions

- Bug fixes, especially in authentication, scope checks, rate limiting and the
  audit trail.
- Notes for identity providers in `docs/authentication.md` that you have
  verified.
- Upgrades to newer Effect release candidates, with whatever API changes they
  need.
- Docs that were wrong or missing when you set the starter up.

Open an issue before starting something larger, such as a new transport, token
introspection or multi-tenancy, so we can agree it belongs in the starter rather
than in your fork.

## Making a change

1. Read [AGENTS.md](AGENTS.md). Its conventions apply to human and agent changes
   alike.
2. Run the checks, with Postgres running (`docker compose up -d`):

   ```bash
   pnpm check && pnpm lint && pnpm format:check
   DATABASE_URL=postgres://mcp:mcp@localhost:5442/mcp pnpm test
   ```

3. Keep pull requests to one change, and say why in the description.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
