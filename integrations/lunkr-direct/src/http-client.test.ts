import { describe, expect, it, vi } from "vitest";
import { SecureHttpClient } from "./http-client.js";

describe("SecureHttpClient", () => {
  it("rejects non-TLS endpoints", () => {
    expect(() => new SecureHttpClient("http://example.test")).toThrow("HTTPS");
  });

  it("builds a Lunkr JSON request without disabling TLS validation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "S_OK", var: { value: true } }), {
        status: 200,
        headers: { "set-cookie": "Cim=test; Path=/; Secure" },
      }),
    );
    const client = new SecureHttpClient("https://example.test", 1_000, fetchImpl);
    const response = await client.lunkr<{ value: boolean }>({
      apiPath: "/lunkr/s/json",
      func: "cim.common:getOrgInfo",
      sid: "sid",
      cookie: "Cim=cookie",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("func=cim.common%3AgetOrgInfo");
    expect(String(url)).toContain("sid=sid");
    expect(init?.headers).toMatchObject({ Cookie: "Cim=cookie" });
    expect(response.body).toEqual({ code: "S_OK", var: { value: true } });
    expect(response.setCookies).toEqual(["Cim=test; Path=/; Secure"]);
    expect(init).not.toHaveProperty("dispatcher");
    expect(init).not.toHaveProperty("agent");
  });

  it("posts binary bytes without JSON serialization and parses JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "S_OK" }), {
        status: 200,
        headers: { "set-cookie": "Cim=rotated; Path=/; Secure" },
      }),
    );
    const client = new SecureHttpClient("https://example.test", 1_000, fetchImpl);
    const bytes = new TextEncoder().encode("中文正文");
    const response = await client.binaryJson<{ code: string }>({
      path: "/lunkr/s/json",
      query: {
        func: "cim.file:directData",
        attachmentId: "attachment-1",
      },
      body: bytes,
      headers: { Cookie: "Cim.sid=sid; Cim=cookie" },
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("func=cim.file%3AdirectData");
    expect(String(url)).toContain("attachmentId=attachment-1");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      Cookie: "Cim.sid=sid; Cim=cookie",
    });
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe("中文正文");
    expect(response.body).toEqual({ code: "S_OK" });
    expect(response.setCookies).toEqual(["Cim=rotated; Path=/; Secure"]);
  });
});
