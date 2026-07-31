import {
  generateKeyPairSync,
  privateDecrypt,
  constants,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import {
  LunkrAuthService,
  encryptRsaPassword,
  parseDomainDiscoveryXml,
} from "./auth.js";

const config: LunkrDirectConfig = {
  baseUrl: "https://lunkr.coremail.cn",
  apiPath: "/lunkr/s/json",
  sessionPath: "unused",
  passwordPath: "unused",
  connectTimeoutMs: 1_000,
  reconnectMaxMs: 1_000,
  messageDedupeTtlMs: 1_000,
  messageDedupeMax: 100,
  contextMaxTurns: 6,
  contextMaxChars: 12_000,
  messageMaxChars: 1_000,
  maxActivePeers: 4,
  maxPendingPerPeer: 5,
  sessionIdleMs: 86_400_000,
};

describe("Lunkr auth", () => {
  it("parses and prioritizes only HTTPS discovery results", () => {
    const result = parseDomainDiscoveryXml(`
      <result><code>S_OK</code><provider>
        <incoming uri="https://mail.example.test/coremail/"/>
        <lookup uri="https://lookup.example.test/coremail/"/>
        <gal uri="http://insecure.example.test/coremail/"/>
      </provider></result>
    `);
    expect(result).toEqual([
      {
        type: "lookup",
        baseUrl: "https://lookup.example.test",
        apiPath: "/coremail/s/json",
      },
      {
        type: "incoming",
        baseUrl: "https://mail.example.test",
        apiPath: "/coremail/s/json",
      },
    ]);
  });

  it("encrypts passwords using the advertised RSA key", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const encrypted = encryptRsaPassword(
      "temporary-password",
      fromBase64Url(jwk.e!),
      fromBase64Url(jwk.n!),
    );
    const plaintext = privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, "base64"),
    ).toString("utf8");
    expect(plaintext).toBe("temporary-password");
  });

  it("does not invoke OTP when the server accepts the password", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const loginKey = pair.publicKey.export({
      format: "der",
      type: "spki",
    }).toString("base64");
    const fetchImpl = createAuthFetch({
      exponent: fromBase64Url(jwk.e!),
      modulus: fromBase64Url(jwk.n!),
      loginKey,
      requireOtp: false,
      cookieInBody: true,
    });
    const save = vi.fn();
    const onOtpRequired = vi.fn<() => Promise<void>>();
    const auth = new LunkrAuthService(
      config,
      { load: vi.fn(), save },
      fetchImpl,
      undefined,
      () => new Date("2026-07-27T00:00:00.000Z"),
    );
    const session = await auth.login({
      email: "bot@example.test",
      password: "temporary-password",
      onOtpRequired,
    });
    expect(onOtpRequired).not.toHaveBeenCalled();
    expect(session.sid).toBe("lunkr-sid");
    expect(save).toHaveBeenCalledOnce();
    expect(JSON.stringify(save.mock.calls)).not.toContain("temporary-password");
    expect(fetchImpl.cookies("user:getAttrs")).toEqual([
      "Coremail=coremail-cookie",
    ]);
    expect(fetchImpl.cookies("cim.common:verify")).toEqual([
      "Coremail=coremail-cookie",
    ]);
  });

  it("only invokes OTP after the server requires it", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const fetchImpl = createAuthFetch({
      exponent: fromBase64Url(jwk.e!),
      modulus: fromBase64Url(jwk.n!),
      loginKey: pair.publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64"),
      requireOtp: true,
    });
    const onOtpRequired = vi.fn(async () => undefined);
    const auth = new LunkrAuthService(
      config,
      { load: vi.fn(), save: vi.fn() },
      fetchImpl,
      undefined,
    );
    await auth.login({
      email: "bot@example.test",
      password: "temporary-password",
      onOtpRequired,
    });
    expect(onOtpRequired).toHaveBeenCalledOnce();
    expect(fetchImpl.calls("user:triggerSecondAuth")).toBe(1);
    expect(fetchImpl.calls("user:querySecondAuthValidateStage")).toBe(1);
  });
});

function createAuthFetch(options: {
  exponent: string;
  modulus: string;
  loginKey: string;
  requireOtp: boolean;
  cookieInBody?: boolean;
}): typeof fetch & {
  calls(func: string): number;
  cookies(func: string): string[];
} {
  const counts = new Map<string, number>();
  const cookies = new Map<string, string[]>();
  let webmailLogins = 0;
  const implementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloud.icoremail.net") {
      return new Response(
        "<result><code>S_OK</code><provider><lookup uri=\"https://mail.example.test/coremail/\"/></provider></result>",
      );
    }
    const func = url.searchParams.get("func") ?? "";
    counts.set(func, (counts.get(func) ?? 0) + 1);
    const cookie = new Headers(init?.headers).get("cookie");
    if (cookie !== null) {
      cookies.set(func, [...(cookies.get(func) ?? []), cookie]);
    }
    if (func === "user:getPasswordKey") {
      return json({
        code: "S_OK",
        var: {
          sid: "rsa-sid",
          key: { type: "rsa", e: options.exponent, n: options.modulus },
        },
      });
    }
    if (func === "user:login") {
      webmailLogins += 1;
      if (options.requireOtp && webmailLogins === 1) {
        return json({ code: "FA_NEED_DYNAMIC_PWD", var: { sid: "temp-sid" } });
      }
      return json(
        {
          code: "S_OK",
          var: {
            sid: "webmail-sid",
            ...(options.cookieInBody
              ? { "Cookie.Coremail": "coremail-cookie" }
              : {}),
          },
        },
        options.cookieInBody
          ? {}
          : { "set-cookie": "Coremail=coremail-cookie; Path=/; Secure" },
      );
    }
    if (func === "user:triggerSecondAuth") return json({ code: "S_OK" });
    if (func === "user:querySecondAuthValidateStage") {
      return json({ code: "S_OK", var: { stage: "VALIDATED" } });
    }
    if (func === "user:getAttrs") return json({ code: "S_OK" });
    if (func === "cim.common:verify") {
      return json({
        code: "S_OK",
        var: { login_key: options.loginKey, login_index: "index" },
      });
    }
    if (func === "cim.user:login") {
      return json(
        { code: "S_OK", var: { sid: "lunkr-sid", self_uid: "#bot#U" } },
        { "set-cookie": "Cim=lunkr-cookie; Path=/; Secure" },
      );
    }
    if (func === "cim.common:getOrgInfo") return json({ code: "S_OK" });
    return json({ code: "UNKNOWN" }, {}, 400);
  });
  return Object.assign(implementation, {
    calls: (func: string) => counts.get(func) ?? 0,
    cookies: (func: string) => cookies.get(func) ?? [],
  }) as unknown as typeof fetch & {
    calls(func: string): number;
    cookies(func: string): string[];
  };
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("hex");
}
