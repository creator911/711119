export const ADMIN_COOKIE = "cn_admin_session";
const ADMIN_SESSION_SECONDS = 60 * 60 * 8;
const encoder = new TextEncoder();

type AdminEnvironment = {
  ADMIN_SESSION_SECRET?: string;
  DB?: {
    prepare: (query: string) => {
      bind: (...values: unknown[]) => { first: <T>() => Promise<T | null> };
    };
  };
};

export type AdminSession = {
  username: string;
  role: "owner" | "level10";
  level: 10;
  canManageAdmins: boolean;
};

const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const toBase64Url = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

async function signature(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function adminConfiguration(environment: unknown, request: Request) {
  const values = environment as AdminEnvironment;
  if (values.ADMIN_SESSION_SECRET) return { secret: values.ADMIN_SESSION_SECRET };
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return { secret: "local-admin-session-secret" };
  return null;
}

export async function createAdminToken(username: string, role: AdminSession["role"], secret: string) {
  const expiresAt = Date.now() + ADMIN_SESSION_SECONDS * 1000;
  const payload = `${role}:${username}.${expiresAt}`;
  return `${payload}.${await signature(secret, payload)}`;
}

export async function adminSession(request: Request, environment: unknown): Promise<AdminSession | null> {
  const configuration = adminConfiguration(environment, request);
  if (!configuration) return null;
  const cookies = request.headers.get("cookie") ?? "";
  const token = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1) ?? "";
  const [subject, expiresAtText, suppliedSignature] = decodeURIComponent(token).split(".");
  const expiresAt = Number(expiresAtText);
  if (!subject || !suppliedSignature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const expected = await signature(configuration.secret, `${subject}.${expiresAtText}`);
  if (!safeEqual(suppliedSignature, expected)) return null;
  const separator = subject.indexOf(":");
  const role = separator > 0 ? subject.slice(0, separator) : "owner";
  const username = separator > 0 ? subject.slice(separator + 1) : subject;
  const database = (environment as AdminEnvironment).DB;
  if (!database) return null;
  if (role === "owner") {
    const owner = await database.prepare("SELECT username,status FROM admin_owners WHERE username=? COLLATE NOCASE").bind(username).first<{ username: string; status: string }>();
    return owner?.status === "active" ? { username: owner.username, role: "owner", level: 10, canManageAdmins: true } : null;
  }
  if (role !== "level10") return null;
  const member = await database.prepare("SELECT username,level,status FROM users WHERE username=? COLLATE NOCASE").bind(username).first<{ username: string; level: number; status: string }>();
  return member?.level === 10 && member.status === "active" ? { username: member.username, role: "level10", level: 10, canManageAdmins: false } : null;
}

export async function isAdminRequest(request: Request, environment: unknown) {
  return Boolean(await adminSession(request, environment));
}

export function adminCookie(token: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
}

export function clearAdminCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}
