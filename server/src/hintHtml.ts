import sanitizeHtml from 'sanitize-html';

// Trust boundary: resident-authored HTML is rendered in a WebView on every viewer's device.
// Whitelist only. No script/style tags, no url() in CSS, no javascript: hrefs.
const FONT_CDN = process.env.HINT_FONT_CDN ?? 'https://fonts.gstatic.com';

export const HINT_HTML_MAX_BYTES = 32 * 1024;

const allowedCss: Record<string, RegExp[]> = {
  color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d.,\s%]+\)$/i, /^[a-z]+$/i],
  'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d.,\s%]+\)$/i, /^[a-z]+$/i],
  'font-family': [/^[\w\s",'-]+$/],
  'font-size': [/^\d+(\.\d+)?(px|em|rem|%)$/],
  'font-weight': [/^(normal|bold|[1-9]00)$/],
  'text-align': [/^(left|right|center|justify)$/],
  padding: [/^[\d.\s]+(px|em|rem|%)?[\d.px em rem%]*$/],
  margin: [/^[\d.\s]+(px|em|rem|%)?[\d.px em rem%]*$/],
  border: [/^[\w\s#().,%-]+$/],
  'border-radius': [/^[\d.\s]+(px|em|rem|%)[\d.px em rem%]*$/],
  'box-shadow': [/^[\w\s#().,%-]+$/],
  'text-shadow': [/^[\w\s#().,%-]+$/],
  animation: [/^[\w\s.,()-]+$/],
  opacity: [/^(0|1|0?\.\d+)$/],
};

export interface SanitizeResult {
  html: string;
  dropped: boolean;
}

/** Returns sanitised HTML; `dropped` is true when anything was stripped (surface it to the author). */
export function sanitizeHintHtml(input: string): SanitizeResult {
  if (Buffer.byteLength(input, 'utf8') > HINT_HTML_MAX_BYTES) {
    throw new Error(`hint html exceeds ${HINT_HTML_MAX_BYTES} bytes`);
  }
  const html = sanitizeHtml(input, {
    allowedTags: ['b', 'i', 'u', 'em', 'strong', 'p', 'span', 'div', 'br',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'img', 'a', 'code', 'pre'],
    allowedAttributes: {
      '*': ['style', 'class'],
      // target/rel are added by transformTags below; they must be allowed or they get stripped after.
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
    },
    allowedSchemes: ['https', 'data'],
    allowedSchemesByTag: { a: ['https'] },
    allowedStyles: { '*': allowedCss },
    allowVulnerableTags: false,
    // Curated font CDN + https images only; data: kept for small inline GIFs.
    allowedIframeHostnames: [],
    transformTags: {
      a: (name, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noreferrer' } }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
  return { html, dropped: html !== input };
}

export const fontCdn = FONT_CDN;
