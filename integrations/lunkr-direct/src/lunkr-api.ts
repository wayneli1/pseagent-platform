import { randomInt, randomUUID } from "node:crypto";
import type { LunkrApiEnvelope, LunkrSession } from "./contracts.js";
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

  async sendTextFile(
    peerUid: string,
    title: string,
    content: string,
    caption: string,
  ): Promise<void> {
    if (!peerUid.endsWith("#U")) throw new Error("只允许向 Lunkr 私聊用户回复");
    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();
    const normalizedCaption = caption.trim();
    if (normalizedTitle === "") throw new Error("Lunkr 附件标题不能为空");
    if (normalizedContent === "") throw new Error("Lunkr 附件正文不能为空");
    if (normalizedCaption === "") throw new Error("Lunkr 附件说明不能为空");
    if (normalizedCaption.length > this.config.messageMaxChars) {
      throw new Error("Lunkr 附件说明超过单条消息字符上限");
    }

    const encoded = new TextEncoder().encode(normalizedContent);
    const composeId = `c:nf:cim${randomInt(1, 10_000)}`;
    const clientMid = randomUUID();
    const uploadUid = this.session.selfUid;
    let cookies = cookieHeader(this.session);

    const prepare = await this.client.lunkr<{ attachmentId?: string }>({
      apiPath: this.config.apiPath,
      func: "cim.file:prepare",
      sid: this.session.sid,
      cookie: cookies,
      body: {
        size: encoded.byteLength,
        composeId,
        fileName: normalizedTitle,
        uid: uploadUid,
        contentType: "text/plain",
      },
    });
    cookies = mergeCookieHeader(cookies, prepare.setCookies);
    assertLunkrSuccess(prepare, "附件准备");
    const attachmentId = prepare.body.var?.attachmentId;
    if (attachmentId === undefined || attachmentId.trim() === "") {
      throw new Error("Lunkr 附件准备未返回 attachmentId");
    }

    const directData = await this.client.binaryJson<LunkrApiEnvelope>({
      path: this.config.apiPath,
      query: {
        func: "cim.file:directData",
        sid: this.session.sid,
        composeId,
        attachmentId,
        offset: "0",
        uid: uploadUid,
      },
      body: encoded,
      headers: { Cookie: cookies },
    });
    cookies = mergeCookieHeader(cookies, directData.setCookies);
    assertLunkrSuccess(directData, "附件数据上传");

    const move = await this.client.lunkr<{ fileId?: string; uid?: string }>({
      apiPath: this.config.apiPath,
      func: "cim.file:moveToNetFolder",
      sid: this.session.sid,
      cookie: cookies,
      body: {
        composeId,
        fileName: normalizedTitle,
        item: "fileName",
        attachmentId,
        uid: uploadUid,
      },
    });
    cookies = mergeCookieHeader(cookies, move.setCookies);
    assertLunkrSuccess(move, "附件入库");
    const fileId = move.body.var?.fileId;
    if (fileId === undefined || fileId.trim() === "") {
      throw new Error("Lunkr 附件入库未返回 fileId");
    }

    const replyBody = {
      uid: peerUid,
      clientMid,
      content: normalizedCaption,
      attachments: [{ fileId, uid: move.body.var?.uid ?? "" }],
    };
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const reply = await this.client.lunkr({
          apiPath: this.config.apiPath,
          func: "cim.msg:reply",
          sid: this.session.sid,
          cookie: cookies,
          body: replyBody,
        });
        cookies = mergeCookieHeader(cookies, reply.setCookies);
        assertLunkrSuccess(reply, "组合消息发送");
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

function assertLunkrSuccess(
  response: {
    readonly status: number;
    readonly body: LunkrApiEnvelope;
  },
  action: string,
): void {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.body.code !== "S_OK"
  ) {
    throw new Error(`Lunkr ${action}失败（code=${response.body.code}）`);
  }
}

function mergeCookieHeader(
  current: string,
  setCookies: readonly string[],
): string {
  const cookies = new Map<string, string>();
  for (const item of current.split(/;\s*/u)) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(item.slice(0, separator), item.slice(separator + 1));
  }
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0]?.trim();
    if (pair === undefined) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
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
