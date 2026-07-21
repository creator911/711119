export const CAPTCHA_COOKIE = "cn_captcha";
export const CAPTCHA_TTL_SECONDS = 5 * 60;

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomToken = (length: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(length)));

async function signature(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

export function createCaptchaAnswer() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

export async function createCaptchaToken(answer: string, secret: string) {
  const nonce = randomToken(12);
  const expiresAt = Date.now() + CAPTCHA_TTL_SECONDS * 1000;
  const digest = await signature(secret, `${nonce}.${expiresAt}.${answer}`);
  return `${nonce}.${expiresAt}.${digest}`;
}

export async function verifyCaptchaToken(token: string, answer: string, secret: string) {
  const [nonce, expiresAtText, suppliedDigest] = token.split(".");
  const expiresAt = Number(expiresAtText);
  if (!nonce || !suppliedDigest || !Number.isFinite(expiresAt) || expiresAt < Date.now() || !/^\d{5}$/.test(answer)) return false;
  const expectedDigest = await signature(secret, `${nonce}.${expiresAt}.${answer}`);
  return safeEqual(suppliedDigest, expectedDigest);
}

export function captchaSecret(environment: unknown) {
  const value = (environment as { CAPTCHA_SECRET?: string }).CAPTCHA_SECRET;
  return value || "local-preview-captcha-secret-change-in-production";
}

export function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

export function captchaCookie(token: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${CAPTCHA_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${CAPTCHA_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearCaptchaCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${CAPTCHA_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
