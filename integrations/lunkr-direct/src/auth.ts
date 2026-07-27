import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
} from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { XMLParser } from "fast-xml-parser";
import type { LunkrApiEnvelope, LunkrSession } from "./contracts.js";
import type { LunkrDirectConfig } from "./config.js";
import { SecureHttpClient, type HttpResponse } from "./http-client.js";
import { SessionStore } from "./session-store.js";

const DOMAIN_QUERY_URL = "https://cloud.icoremail.net/querydomain/query";
const LOGIN_OK_CODES = new Set(["S_OK", "FA_NEED_ACCESS_SECRET"]);
const PASSWORD_ERROR_CODES = new Set(["PASSWORD_ERROR", "AUTH_FAILED"]);

export class LunkrAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LunkrAuthError";
  }
}

export class LunkrPasswordError extends LunkrAuthError {
  constructor() {
    super("邮箱或密码错误");
    this.name = "LunkrPasswordError";
  }
}

export interface DiscoveredServer {
  readonly type: string;
  readonly baseUrl: string;
  readonly apiPath: string;
}

export interface RsaLoginKey {
  readonly sid: string;
  readonly authType: string;
  readonly exponentHex: string;
  readonly modulusHex: string;
}

export interface DomainDiscoveryResult {
  readonly server: DiscoveredServer;
  readonly key: RsaLoginKey;
}

interface DeviceInfo {
  readonly deviceType: "AI-Bot";
  readonly friendlyName: string;
  readonly model: string;
  readonly os: string;
  readonly uuid: string;
}

export interface LoginOptions {
  readonly email: string;
  readonly password: string;
  readonly onOtpRequired?: () => Promise<void>;
}

export class DomainDiscoveryService {
  constructor(
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async discover(email: string): Promise<DomainDiscoveryResult> {
    const domain = extractEmailDomain(email);
    const url = new URL(DOMAIN_QUERY_URL);
    url.searchParams.set("domain", domain);
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new LunkrAuthError(`域名发现失败（status=${response.status}）`);
    }
    const servers = parseDomainDiscoveryXml(await response.text());
    for (const server of servers) {
      const client = new SecureHttpClient(server.baseUrl, this.timeoutMs, this.fetchImpl);
      try {
        const keyResponse = await client.lunkr<Record<string, unknown>>({
          apiPath: server.apiPath,
          func: "user:getPasswordKey",
          uid: email,
        });
        const key = parseRsaLoginKey(keyResponse.body);
        if (key !== undefined) return { server, key };
      } catch {
        // Continue to the next server returned by the trusted discovery endpoint.
      }
    }
    throw new LunkrAuthError("未找到可用的邮箱登录服务器");
  }
}

export class LunkrAuthService {
  constructor(
    private readonly config: LunkrDirectConfig,
    private readonly store: Pick<SessionStore, "load" | "save"> =
      new SessionStore(config.sessionPath),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly discovery = new DomainDiscoveryService(
      config.connectTimeoutMs,
      fetchImpl,
    ),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(options: LoginOptions): Promise<LunkrSession> {
    const email = normalizeEmail(options.email);
    if (options.password.length === 0) throw new LunkrPasswordError();
    const { server, key } = await this.discovery.discover(email);
    const webmail = new SecureHttpClient(
      server.baseUrl,
      this.config.connectTimeoutMs,
      this.fetchImpl,
    );
    const device = createDeviceInfo(email);

    let login = await loginToWebmail(webmail, server.apiPath, {
      email,
      password: options.password,
      key,
      device,
    });
    if (login.code === "FA_NEED_DYNAMIC_PWD") {
      await completeOtp(
        webmail,
        server.apiPath,
        email,
        key,
        device,
        options.onOtpRequired,
      );
      login = await loginToWebmail(webmail, server.apiPath, {
        email,
        password: "",
        key,
        device,
      });
    }
    if (!LOGIN_OK_CODES.has(login.code)) handleLoginFailure(login);
    const webmailSid = readString(login.body.var, "sid");
    if (webmailSid === undefined) {
      throw new LunkrAuthError("邮箱登录未返回 Session");
    }
    const coremailCookie =
      extractCookie(login.setCookies, "Coremail") ??
      normalizeCookieValue(
        readString(login.body.var, "Cookie.Coremail"),
        "Coremail",
      );
    if (coremailCookie === undefined) {
      throw new LunkrAuthError("邮箱登录未返回 Coremail Cookie");
    }
    await requireSuccess(await webmail.lunkr({
      apiPath: server.apiPath,
      func: "user:getAttrs",
      sid: webmailSid,
      cookie: `Coremail=${coremailCookie}`,
      body: { attrIds: ["true_name"] },
    }), "邮箱 Session 验证失败");
    const lunkrSession = await exchangeLunkrSession(
      this.config,
      email,
      webmailSid,
      coremailCookie,
      device,
      this.fetchImpl,
    );
    const timestamp = this.now().toISOString();
    const session: LunkrSession = {
      email,
      selfUid: lunkrSession.selfUid,
      deviceUuid: device.uuid,
      sid: lunkrSession.sid,
      cookie: lunkrSession.cookie,
      createdAt: timestamp,
      lastVerifiedAt: timestamp,
    };
    if (!(await this.verify(session))) {
      throw new LunkrAuthError("Lunkr Session 验证失败");
    }
    await this.store.save(session);
    return session;
  }

  async verify(session: LunkrSession): Promise<boolean> {
    const client = new SecureHttpClient(
      this.config.baseUrl,
      this.config.connectTimeoutMs,
      this.fetchImpl,
    );
    try {
      const response = await client.lunkr({
        apiPath: this.config.apiPath,
        func: "cim.common:getOrgInfo",
        sid: session.sid,
        cookie: session.cookie,
      });
      return response.status >= 200 &&
        response.status < 300 &&
        response.body.code === "S_OK";
    } catch {
      return false;
    }
  }
}

export function parseDomainDiscoveryXml(xml: string): DiscoveredServer[] {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  }).parse(xml) as Record<string, unknown>;
  const root = asRecord(parsed.result) ?? asRecord(parsed.querydomain);
  if (root === undefined || root.code !== "S_OK") {
    throw new LunkrAuthError("域名发现响应无效");
  }
  const provider = asRecord(root.provider);
  if (provider === undefined) throw new LunkrAuthError("域名发现缺少 provider");
  const result: DiscoveredServer[] = [];
  for (const [type, rawEntries] of Object.entries(provider)) {
    if (type.startsWith("@_")) continue;
    for (const rawEntry of Array.isArray(rawEntries) ? rawEntries : [rawEntries]) {
      const uri = asRecord(rawEntry)?.["@_uri"];
      if (typeof uri !== "string") continue;
      const parsedUri = new URL(uri);
      if (parsedUri.protocol !== "https:") continue;
      const path = parsedUri.pathname.replace(/\/+$/, "");
      result.push({
        type,
        baseUrl: parsedUri.origin,
        apiPath: path === "" ? "/s/json" : `${path}/s/json`,
      });
    }
  }
  return result.sort((left, right) => priority(left.type) - priority(right.type));
}

export function encryptRsaPassword(
  password: string,
  exponentHex: string,
  modulusHex: string,
): string {
  const key = createPublicKey({
    key: buildRsaSpkiDer(exponentHex, modulusHex),
    format: "der",
    type: "spki",
  });
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  ).toString("base64");
}

async function loginToWebmail(
  client: SecureHttpClient,
  apiPath: string,
  input: {
    readonly email: string;
    readonly password: string;
    readonly key: RsaLoginKey;
    readonly device: DeviceInfo;
  },
): Promise<{
  readonly code: string;
  readonly body: LunkrApiEnvelope<Record<string, unknown>>;
  readonly setCookies: readonly string[];
}> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const accessToken = accessTokenFor(input.device.uuid, input.email, input.device.friendlyName);
  const secret = createHash("sha1")
    .update(`${accessToken}cksjahfkdl&%789sdkjfKJHjhasfkHkk_)+.`)
    .digest("hex");
  const password = input.password === "" || input.key.authType.toLowerCase() !== "rsa"
    ? input.password
    : encryptRsaPassword(
        input.password,
        input.key.exponentHex,
        input.key.modulusHex,
      );
  const response = await client.lunkr<Record<string, unknown>>({
    apiPath,
    func: "user:login",
    sid: input.key.sid,
    body: {
      uid: input.email,
      password,
      authType: input.key.authType,
      device: input.device,
      locale: "zh_CN",
      timestamp,
      accessToken,
      signature: signatureFor(accessToken, timestamp, secret),
      supportDynamicPwd: true,
      supportBind2FA: true,
      supportPermDomains: true,
      supportSms: 1,
      forceIPCheck: false,
      forceCookieCheck: true,
      returnCookie: true,
      returnMainURL: false,
    },
  });
  return {
    code: response.body.code,
    body: response.body,
    setCookies: response.setCookies,
  };
}

async function completeOtp(
  client: SecureHttpClient,
  apiPath: string,
  email: string,
  key: RsaLoginKey,
  device: DeviceInfo,
  onOtpRequired: (() => Promise<void>) | undefined,
): Promise<void> {
  const accessToken = accessTokenFor(device.uuid, email, device.friendlyName);
  const secret = createHash("sha1")
    .update(`${accessToken}cksjahfkdl&%789sdkjfKJHjhasfkHkk_)+.`)
    .digest("hex");
  await requireSuccess(await client.lunkr({
    apiPath,
    func: "user:triggerSecondAuth",
    sid: key.sid,
    body: {
      tempSid: key.sid,
      trans: "login",
      device: { ...device, token: accessToken, secret },
      type: "OTP",
    },
  }), "触发二次验证失败");
  if (onOtpRequired === undefined) {
    throw new LunkrAuthError("服务端要求二次验证，请使用交互式登录命令");
  }
  await onOtpRequired();
  const query = await client.lunkr<Record<string, unknown>>({
    apiPath,
    func: "user:querySecondAuthValidateStage",
    sid: key.sid,
    body: { tempSid: key.sid, trans: "login" },
  });
  await requireSuccess(query, "查询二次验证状态失败");
  if (readString(query.body.var, "stage") !== "VALIDATED") {
    throw new LunkrAuthError("二次验证尚未完成");
  }
}

async function exchangeLunkrSession(
  config: LunkrDirectConfig,
  email: string,
  webmailSid: string,
  coremailCookie: string,
  device: DeviceInfo,
  fetchImpl: typeof fetch,
): Promise<{ readonly sid: string; readonly selfUid: string; readonly cookie: string }> {
  const client = new SecureHttpClient(
    config.baseUrl,
    config.connectTimeoutMs,
    fetchImpl,
  );
  const verify = await client.lunkr<Record<string, unknown>>({
    apiPath: config.apiPath,
    func: "cim.common:verify",
    cookie: `Coremail=${coremailCookie}`,
  });
  await requireSuccess(verify, "Lunkr 登录凭据交换失败");
  const loginKey = readString(verify.body.var, "login_key");
  if (loginKey === undefined) throw new LunkrAuthError("Lunkr 未返回 login_key");
  const tokenInput = Buffer.from(
    `${webmailSid}:${coremailCookie}`,
    "utf8",
  ).toString("base64");
  const tokenKey = createPublicKey({
    key: Buffer.from(loginKey, "base64"),
    format: "der",
    type: "spki",
  });
  const xCmToken = publicEncrypt(
    { key: tokenKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(tokenInput, "utf8"),
  ).toString("base64");
  const loginIndex = readString(verify.body.var, "login_index");
  const login = await client.lunkr<Record<string, unknown>>({
    apiPath: config.apiPath,
    func: "cim.user:login",
    headers: { "X-CM-TOKEN": xCmToken },
    body: {
      uid: email,
      forceCookieCheck: true,
      bindingRemoteCoremail: true,
      setCookieKey: true,
      version: "2.0.5.8",
      open: true,
      device: {
        uuid: device.uuid,
        os: device.os,
        model: device.model,
        friendlyName: device.friendlyName,
      },
      ...(loginIndex === undefined ? {} : { login_index: loginIndex }),
    },
  });
  if (!LOGIN_OK_CODES.has(login.body.code)) {
    throw new LunkrAuthError(`Lunkr 登录失败（code=${login.body.code}）`);
  }
  const sid = readString(login.body.var, "sid");
  const selfUid =
    readString(login.body.var, "self_uid") ??
    readString(login.body.var, "uid");
  const cookie = extractCookie(login.setCookies, "Cim");
  if (sid === undefined || selfUid === undefined || cookie === undefined) {
    throw new LunkrAuthError("Lunkr 登录响应缺少 Session、账号 UID 或 Cookie");
  }
  return { sid, selfUid, cookie: `Cim=${cookie}` };
}

function parseRsaLoginKey(
  envelope: LunkrApiEnvelope<Record<string, unknown>>,
): RsaLoginKey | undefined {
  if (envelope.code !== "S_OK") return undefined;
  const variables = asRecord(envelope.var);
  const key = asRecord(variables?.key);
  const sid = variables?.sid;
  const authType = key?.type;
  if (typeof sid !== "string" || typeof authType !== "string") return undefined;
  return {
    sid,
    authType,
    exponentHex: typeof key?.e === "string" ? key.e : "",
    modulusHex: typeof key?.n === "string" ? key.n : "",
  };
}

function handleLoginFailure(login: {
  readonly code: string;
  readonly body: LunkrApiEnvelope<Record<string, unknown>>;
}): never {
  const variables = asRecord(login.body.var);
  const detail = `${String(variables?.error ?? "")} ${String(variables?.msg ?? "")}`;
  if (
    PASSWORD_ERROR_CODES.has(login.code) ||
    /password|密码/i.test(detail)
  ) {
    throw new LunkrPasswordError();
  }
  if (login.code === "FA_NEED_VERIFY_CODE") {
    throw new LunkrAuthError("服务端要求验证码，当前登录流程不能绕过");
  }
  throw new LunkrAuthError(`邮箱登录失败（code=${login.code}）`);
}

async function requireSuccess(
  response: HttpResponse<LunkrApiEnvelope<unknown>>,
  message: string,
): Promise<void> {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.body.code !== "S_OK"
  ) {
    throw new LunkrAuthError(`${message}（code=${response.body.code}）`);
  }
}

function createDeviceInfo(email: string): DeviceInfo {
  const name = hostname();
  const system = platform();
  const uuid = createHash("sha256")
    .update(`${name}:${system}:${arch()}:${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 40);
  return {
    deviceType: "AI-Bot",
    friendlyName: name,
    model: system === "win32" ? "windows" : system,
    os: `${system} ${release()} ${arch()}`,
    uuid,
  };
}

function accessTokenFor(uuid: string, email: string, friendlyName: string): string {
  return `!AIBot:${createHash("sha1")
    .update(`${uuid}${email}${friendlyName}`)
    .digest("hex")}`;
}

function signatureFor(accessToken: string, timestamp: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
  return createHash("sha1")
    .update(`accessToken=${encode(accessToken)}&timestamp=${timestamp}&secret=${encode(secret)}`)
    .digest("base64");
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  extractEmailDomain(value);
  return value;
}

function extractEmailDomain(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) {
    throw new LunkrAuthError("请输入有效邮箱地址");
  }
  return email.slice(separator + 1).toLowerCase();
}

function readString(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function extractCookie(setCookies: readonly string[], name: string): string | undefined {
  for (const header of setCookies) {
    const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function normalizeCookieValue(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? value;
}

function priority(type: string): number {
  if (type === "lookup") return 0;
  if (/^gal\d*$/.test(type)) {
    const suffix = type.slice(3);
    return 10 + (suffix === "" ? 0 : Number(suffix));
  }
  if (type === "incoming") return 100;
  if (type === "outgoing") return 200;
  if (type === "mirror") return 300;
  return 1_000;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function derInteger(hex: string): Buffer {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  let bytes = Buffer.from(normalized, "hex");
  if (bytes.length === 0) throw new LunkrAuthError("RSA 公钥为空");
  if ((bytes[0]! & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02]), derLength(bytes.length), bytes]);
}

function derSequence(contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(contents.length), contents]);
}

function buildRsaSpkiDer(exponentHex: string, modulusHex: string): Buffer {
  const publicKey = derSequence(Buffer.concat([
    derInteger(modulusHex),
    derInteger(exponentHex),
  ]));
  const algorithm = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
    0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    derLength(publicKey.length + 1),
    Buffer.from([0]),
    publicKey,
  ]);
  return derSequence(Buffer.concat([algorithm, bitString]));
}
