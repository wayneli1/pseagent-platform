import type { LunkrSession } from "./contracts.js";
import type { LunkrDirectConfig } from "./config.js";
import { SecureHttpClient } from "./http-client.js";

export class LunkrApi {
  private readonly client: SecureHttpClient;

  constructor(
    private readonly config: LunkrDirectConfig,
    private readonly session: LunkrSession,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new SecureHttpClient(
      config.baseUrl,
      config.connectTimeoutMs,
      fetchImpl,
    );
  }

  async sendText(peerUid: string, text: string): Promise<void> {
    if (!peerUid.endsWith("#U")) throw new Error("只允许向 Lunkr 私聊用户回复");
    for (const chunk of splitText(text, this.config.messageMaxChars)) {
      const response = await this.client.lunkr({
        apiPath: this.config.apiPath,
        func: "cim.msg:reply",
        sid: this.session.sid,
        cookie: cookieHeader(this.session),
        body: { uid: peerUid, content: chunk },
      });
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.body.code !== "S_OK"
      ) {
        throw new Error(`Lunkr 私聊发送失败（code=${response.body.code}）`);
      }
    }
  }

  async sendPost(peerUid: string, title: string, content: string): Promise<void> {
    if (!peerUid.endsWith("#U")) throw new Error("只允许向 Lunkr 私聊用户回复");
    if (title.trim() === "") throw new Error("Lunkr 长回答标题不能为空");
    if (content.trim() === "") throw new Error("Lunkr 长回答正文不能为空");

    const response = await this.client.lunkr({
      apiPath: this.config.apiPath,
      func: "cim.file:uploadPost",
      sid: this.session.sid,
      cookie: cookieHeader(this.session),
      body: {
        uid: peerUid,
        fileInfo: { title, content },
      },
    });
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body.code !== "S_OK"
    ) {
      throw new Error(`Lunkr 长回答发送失败（code=${response.body.code}）`);
    }
  }
}

export function splitText(text: string, maxChars = 1_000): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars 必须是正整数");
  }
  const normalized = text.trim();
  if (normalized === "") return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const minimumBoundary = Math.floor(maxChars * 0.55);
    const newline = window.lastIndexOf("\n", maxChars);
    const sentence = Math.max(
      window.lastIndexOf("。", maxChars),
      window.lastIndexOf("！", maxChars),
      window.lastIndexOf("？", maxChars),
    );
    const whitespace = window.lastIndexOf(" ", maxChars);
    const boundary = [newline, sentence + 1, whitespace]
      .find((candidate) => candidate >= minimumBoundary) ?? maxChars;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining !== "") chunks.push(remaining);
  return chunks;
}

export function cookieHeader(session: LunkrSession): string {
  return `Cim.sid=${session.sid}; ${session.cookie}`;
}
