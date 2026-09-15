# Security

## Reporting a vulnerability

Email **hello@vantion.co** with "Security" in the subject. Include a
description, the affected commit, and steps to reproduce. Please do not open
a public issue.

We aim to reply within a few working days, confirm the issue, agree a
disclosure date with you, and credit you in the release notes unless you
prefer not to be named.

## Scope

In scope: code in this repository, including token verification, API key
handling, scope checks, the rate limiter, audit logging, and any way to call a
tool without passing through `ToolGuard`.

Out of scope: vulnerabilities in dependencies (report those upstream), your
identity provider's configuration, and issues that need a misconfigured
deployment, such as a leaked database or a server exposed without HTTPS.

## Running it safely

- Serve it over HTTPS only. Tokens and API keys are bearer credentials.
- Set `PUBLIC_URL` correctly: it defines the audience tokens must carry, which is
  what stops a token issued for another service from working here.
- Give API keys the fewest scopes that work, and revoke keys nobody uses.
- Treat tool results as data the model will read and may repeat. Do not return
  secrets or more personal data than the task needs.
- Remember that an agent calling a tool may be acting on instructions from a
  document or web page it read. Scopes and the systems behind the tools are the
  real boundary, not the agent's judgement.
