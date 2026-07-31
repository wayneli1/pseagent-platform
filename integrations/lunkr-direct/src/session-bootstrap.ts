import type { LunkrAuthService } from "./auth.js";
import type { LunkrSession } from "./contracts.js";
import type {
  DpapiPasswordStore,
  StoredPasswordCredential,
} from "./password-store.js";
import type { SessionStore } from "./session-store.js";

type SessionStoreFacade = Pick<SessionStore, "load">;
type PasswordStoreFacade = Pick<DpapiPasswordStore, "load">;
type AuthFacade = Pick<LunkrAuthService, "verify" | "login">;

export class LunkrLoginRequiredError extends Error {
  constructor(
    readonly reason:
      | "missing_session"
      | "invalid_session"
      | "stored_account_mismatch",
  ) {
    super(reason);
    this.name = "LunkrLoginRequiredError";
  }
}

export async function ensureLunkrSession(input: {
  readonly sessions: SessionStoreFacade;
  readonly passwords: PasswordStoreFacade;
  readonly auth: AuthFacade;
}): Promise<{
  readonly session: LunkrSession;
  readonly renewedWithStoredPassword: boolean;
}> {
  const existing = await input.sessions.load();
  if (existing !== undefined && await input.auth.verify(existing)) {
    return {
      session: existing,
      renewedWithStoredPassword: false,
    };
  }

  const credential = await input.passwords.load();
  if (credential === undefined) {
    throw new LunkrLoginRequiredError(
      existing === undefined ? "missing_session" : "invalid_session",
    );
  }
  validateStoredAccount(existing, credential);
  const session = await input.auth.login({
    email: credential.email,
    password: credential.password,
  });
  return {
    session,
    renewedWithStoredPassword: true,
  };
}

function validateStoredAccount(
  existing: LunkrSession | undefined,
  credential: StoredPasswordCredential,
): void {
  if (
    existing !== undefined &&
    existing.email.toLowerCase() !== credential.email.toLowerCase()
  ) {
    throw new LunkrLoginRequiredError("stored_account_mismatch");
  }
}
