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
});
