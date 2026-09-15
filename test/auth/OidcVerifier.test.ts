import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OidcVerifier } from "../../src/auth/OidcVerifier.ts";
import { ISSUER, jwks, RESOURCE, signToken } from "../support/TestServer.ts";

const verifier = OidcVerifier.make({ issuer: ISSUER, audience: RESOURCE, keys: jwks });

describe("OidcVerifier", () => {
  it.effect("turns a token into a principal named by email, then username, then subject", () =>
    Effect.gen(function*() {
      const withEmail = yield* Effect.promise(() => signToken({ jti: "t1" }));
      const withUsername = yield* Effect.promise(() =>
        signToken({ email: undefined, preferred_username: "ada" })
      );
      const bare = yield* Effect.promise(() => signToken({ email: undefined }));

      const principals = yield* Effect.forEach([withEmail, withUsername, bare], verifier.verify);

      expect(principals.map((p) => p.displayName)).toEqual(["ada@example.com", "ada", "user_ada"]);
      expect(principals[0]).toMatchObject({
        subject: "user_ada",
        credentialId: "t1",
        scopes: ["crm:read"],
      });
    }));

  it.effect("refuses a token from another issuer or without a subject", () =>
    Effect.gen(function*() {
      const otherIssuer = yield* Effect.promise(() =>
        signToken({ iss: "https://evil.example.com/" })
      );
      const noSubject = yield* Effect.promise(() => signToken({ sub: undefined }));

      for (const token of [otherIssuer, noSubject]) {
        const error = yield* Effect.flip(verifier.verify(token));
        expect(error).toMatchObject({ _tag: "CredentialRejected", reason: "Invalid" });
      }
    }));

  it.effect("tells an expired token apart from a forged one", () =>
    Effect.gen(function*() {
      const expired = yield* Effect.promise(() => signToken({ expiresIn: "-1m" }));
      const error = yield* Effect.flip(verifier.verify(expired));
      expect(error).toMatchObject({ _tag: "CredentialRejected", reason: "Expired" });
    }));
});
