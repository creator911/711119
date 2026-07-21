import { env } from "cloudflare:workers";
import { captchaCookie, captchaSecret, createCaptchaAnswer, createCaptchaToken } from "../../lib/captcha";

const randomBetween = (minimum: number, maximum: number) => {
  const [value] = crypto.getRandomValues(new Uint8Array(1));
  return minimum + (value % (maximum - minimum + 1));
};

function captchaSvg(answer: string) {
  const digits = answer.split("").map((digit, index) => {
    const x = 25 + index * 30;
    const y = randomBetween(42, 55);
    const rotation = randomBetween(-16, 16);
    return `<text x="${x}" y="${y}" transform="rotate(${rotation} ${x} ${y})">${digit}</text>`;
  }).join("");
  const lines = Array.from({ length: 7 }, () => {
    const x1 = randomBetween(0, 170);
    const y1 = randomBetween(4, 62);
    const x2 = randomBetween(0, 170);
    const y2 = randomBetween(4, 62);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }).join("");
  const dots = Array.from({ length: 34 }, () => `<circle cx="${randomBetween(3, 167)}" cy="${randomBetween(3, 61)}" r="${randomBetween(1, 2)}" />`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="170" height="64" viewBox="0 0 170 64" role="img" aria-label="자동 등록 방지 숫자 이미지">
    <rect width="170" height="64" rx="6" fill="#f5f4f1"/>
    <g stroke="#b9b7b2" stroke-width="1" opacity=".65">${lines}</g>
    <g fill="#c6c2bc" opacity=".8">${dots}</g>
    <g fill="#171717" font-family="Georgia, 'Times New Roman', serif" font-size="37" font-weight="700" font-style="italic">${digits}</g>
  </svg>`;
}

export async function GET(request: Request) {
  const answer = createCaptchaAnswer();
  const token = await createCaptchaToken(answer, captchaSecret(env));
  return new Response(captchaSvg(answer), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Set-Cookie": captchaCookie(token, request),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
