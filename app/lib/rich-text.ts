const allowedTags = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "font", "h3", "h4", "i", "iframe", "img", "li", "ol", "p", "pre", "s", "span", "strike",
  "strong", "table", "tbody", "td", "th", "tr", "u", "ul", "video",
]);
const voidTags = new Set(["br", "img"]);
const allowedStyleProps = new Set(["background-color", "color", "font-family", "font-size", "text-align"]);

const escapeText = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const safeUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^\/api\/media\/[0-9a-f-]{36}\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  return "";
};
const safeMediaUrl = (value: string) => {
  const trimmed = value.trim();
  if (/^\/api\/media\/[0-9a-f-]{36}\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  if (/^\/api\/support\/media\/[0-9a-f-]{36}\.[a-z0-9]+$/i.test(trimmed)) return trimmed;
  if (/^\/api\/shop\/vouchers\/\d+\/image$/i.test(trimmed)) return trimmed;
  return "";
};
const safeYouTubeUrl = (value: string) => /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(value.trim()) ? value.trim() : "";

const safeStyle = (value: string) => value
  .split(";")
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const [property = "", ...rest] = part.split(":");
    const name = property.trim().toLowerCase();
    const styleValue = rest.join(":").trim();
    if (!allowedStyleProps.has(name) || !styleValue || /url\s*\(|expression\s*\(|javascript:/i.test(styleValue)) return "";
    return `${name}:${styleValue}`;
  })
  .filter(Boolean)
  .join(";");

const safeAttrs = (tag: string, raw: string) => {
  const attrs: string[] = [];
  for (const match of raw.matchAll(/([a-zA-Z0-9:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const style = safeStyle(value);
      if (style) attrs.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (tag === "a" && name === "href") {
      const href = safeUrl(value);
      if (href) attrs.push(`href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"`);
      continue;
    }
    if (tag === "img" && name === "src") {
      const src = safeMediaUrl(value);
      if (src) attrs.push(`src="${escapeAttr(src)}" loading="lazy" alt="첨부 이미지"`);
      continue;
    }
    if (tag === "video" && name === "src") {
      const src = safeMediaUrl(value);
      if (src) attrs.push(`src="${escapeAttr(src)}"`);
      continue;
    }
    if (tag === "video" && name === "controls") attrs.push(`controls="controls"`);
    if (tag === "video" && name === "preload" && ["none", "metadata"].includes(value)) attrs.push(`preload="${value}"`);
    if (tag === "video" && name === "playsinline") attrs.push(`playsinline="playsinline"`);
    if (tag === "iframe" && name === "src") {
      const src = safeYouTubeUrl(value);
      if (src) attrs.push(`src="${escapeAttr(src)}"`);
      continue;
    }
    if (tag === "iframe" && name === "title") attrs.push(`title="${escapeAttr(value.slice(0, 80))}"`);
    if (tag === "iframe" && name === "loading" && value === "lazy") attrs.push('loading="lazy"');
    if (tag === "iframe" && name === "allow" && /^[a-z; -]+$/i.test(value)) attrs.push(`allow="${escapeAttr(value)}"`);
    if (tag === "iframe" && name === "referrerpolicy" && value === "strict-origin-when-cross-origin") attrs.push('referrerpolicy="strict-origin-when-cross-origin"');
    if (tag === "iframe" && name === "allowfullscreen") attrs.push('allowfullscreen="allowfullscreen"');
    if (tag === "font" && ["color", "face", "size"].includes(name)) attrs.push(`${name}="${escapeAttr(value)}"`);
    if (name === "class" && /^media-card$|^editor-table$|^editor-media-block$|^editor-youtube-block$|^post-poll-slot$/.test(value)) attrs.push(`class="${value}"`);
    if (tag === "div" && name === "data-poll-id" && /^\d+$/.test(value)) attrs.push(`data-poll-id="${value}"`);
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
};

export function sanitizeRichHtml(input: string) {
  const source = input.trim().slice(0, 20000);
  let html = "";
  let lastIndex = 0;
  source.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, rawTag, rawAttrs, offset) => {
    html += escapeText(source.slice(lastIndex, offset));
    lastIndex = offset + match.length;
    const tag = rawTag.toLowerCase();
    if (!allowedTags.has(tag)) return "";
    if (match.startsWith("</")) {
      if (!voidTags.has(tag)) html += `</${tag}>`;
      return "";
    }
    html += `<${tag}${safeAttrs(tag, rawAttrs)}${voidTags.has(tag) ? " />" : ">"}`
    return "";
  });
  html += escapeText(source.slice(lastIndex));
  return html
    .replace(/<iframe(?![^>]*\ssrc=)[^>]*><\/iframe>/gi, "")
    .replace(/<img(?![^>]*\ssrc=)[^>]*\/?>/gi, "")
    .replace(/<video(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/video>/gi, "")
    .replace(/<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, "<p><br /></p>")
    .replace(/(?:<br\s*\/?>\s*){4,}/gi, "<br /><br /><br />");
}

export function richTextLength(input: string) {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .length;
}

export function hasRichMedia(input: string) {
  return /<(?:img|video|iframe)\b/i.test(input);
}

export function normalizeRichBody(input: string) {
  const body = sanitizeRichHtml(input);
  return { body, textLength: richTextLength(body) };
}

export function renderRichBody(input: string) {
  return /<\/?[a-z][\s\S]*>/i.test(input) ? sanitizeRichHtml(input) : escapeText(input).replace(/\n/g, "<br />");
}

export function protectSupportMediaUrls(input: string) {
  return input.replace(/\/api\/media\/([0-9a-f-]{36}\.[a-z0-9]+)/gi, "/api/support/media/$1");
}

const titleAllowedTags = new Set(["span", "font", "b", "strong", "i", "em", "u", "s", "strike"]);
const safeTitleColor = (value: string) => {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(trimmed)) return trimmed.toLowerCase();
  const rgb = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i);
  if (!rgb) return "";
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  if ([r, g, b].some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return "";
  return `rgb(${r},${g},${b})`;
};

const safeTitleStyle = (value: string) => value
  .split(";")
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const [property = "", ...rest] = part.split(":");
    const name = property.trim().toLowerCase();
    const styleValue = rest.join(":").trim();
    if (name !== "color") return "";
    const color = safeTitleColor(styleValue);
    return color ? `color:${color}` : "";
  })
  .filter(Boolean)
  .join(";");

const safeTitleAttrs = (tag: string, raw: string) => {
  const attrs: string[] = [];
  for (const match of raw.matchAll(/([a-zA-Z0-9:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (name.startsWith("on")) continue;
    if (name === "style") {
      const style = safeTitleStyle(value);
      if (style) attrs.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (tag === "font" && name === "color") {
      const color = safeTitleColor(value);
      if (color) attrs.push(`color="${escapeAttr(color)}"`);
    }
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
};

export function stripRichTitle(input: string) {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeRichTitle(input: string) {
  const source = input.trim().slice(0, 1200).replace(/[\r\n\t]+/g, " ");
  let html = "";
  let lastIndex = 0;
  source.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, rawTag, rawAttrs, offset) => {
    html += escapeText(source.slice(lastIndex, offset));
    lastIndex = offset + match.length;
    const tag = rawTag.toLowerCase();
    if (!titleAllowedTags.has(tag)) return "";
    if (match.startsWith("</")) {
      html += `</${tag}>`;
      return "";
    }
    html += `<${tag}${safeTitleAttrs(tag, rawAttrs)}>`;
    return "";
  });
  html += escapeText(source.slice(lastIndex));
  return html
    .replace(/<([^ >]+)(?:\s[^>]*)?><\/\1>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeRichTitle(input: string) {
  const title = sanitizeRichTitle(input);
  return { title, textLength: stripRichTitle(title).length };
}

export function renderRichTitle(input: string) {
  return /<\/?[a-z][\s\S]*>/i.test(input) ? sanitizeRichTitle(input) : escapeText(input);
}
