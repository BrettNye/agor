import { AggregationColor } from 'antd/es/color-picker/color';

// Contrast endpoints are physical display colors, not theme surfaces. They
// must remain absolute so a dark algorithm cannot turn both candidates white.
// biome-ignore lint/plugin/noHardcodedColorLiteral: absolute WCAG contrast endpoint
const ABSOLUTE_BLACK = '#000000';
// biome-ignore lint/plugin/noHardcodedColorLiteral: absolute WCAG contrast endpoint
const ABSOLUTE_WHITE = '#ffffff';

/**
 * Shared theme helpers.
 *
 * Centralizes theme detection logic so components can make consistent
 * decisions based on the current Ant Design token values.
 */
export const isDarkTheme = (token: { colorBgLayout?: string | undefined }): boolean =>
  token.colorBgLayout?.startsWith?.('#0') ||
  token.colorBgLayout?.startsWith?.('rgb(0') ||
  token.colorBgLayout?.startsWith?.('rgba(0') ||
  false;

/** Pick a theme-aware foreground for an arbitrary user/data color. */
export const getContrastingTextColor = (
  background: string,
  token: { colorText: string }
): string => {
  try {
    const { r, g, b, a } = new AggregationColor(background).toRgb();
    if (a < 0.3) return token.colorText;
    const linearize = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
    const blackContrast = (luminance + 0.05) / 0.05;
    const whiteContrast = 1.05 / (luminance + 0.05);
    return blackContrast >= whiteContrast ? ABSOLUTE_BLACK : ABSOLUTE_WHITE;
  } catch {
    return token.colorText;
  }
};

/**
 * Ensures a color has sufficient visibility by adjusting brightness while preserving hue.
 * For dark themes: increases brightness for pale colors
 * For light themes: decreases brightness for pale colors
 *
 * @param color - Input color (any CSS color format)
 * @param isDark - Whether the current theme is dark
 * @param minBrightness - Minimum brightness percentage for dark theme (0-100)
 * @param maxBrightness - Maximum brightness percentage for light theme (0-100)
 * @returns Adjusted color as hex string
 */
export const ensureColorVisible = (
  color: string,
  isDark: boolean,
  minBrightness = 50,
  maxBrightness = 50
): string => {
  try {
    // Clamp inputs to valid range [0, 100]
    const clampedMin = Math.max(0, Math.min(100, minBrightness));
    const clampedMax = Math.max(0, Math.min(100, maxBrightness));

    const colorObj = new AggregationColor(color);
    const hsb = colorObj.toHsb();

    // For dark theme: ensure color is bright enough
    if (isDark && hsb.b < clampedMin) {
      hsb.b = clampedMin;
      return new AggregationColor(hsb).toHexString();
    }

    // For light theme: ensure color is dark enough
    if (!isDark && hsb.b > clampedMax) {
      hsb.b = clampedMax;
      return new AggregationColor(hsb).toHexString();
    }

    // Color is already visible
    return colorObj.toHexString();
  } catch {
    // Fallback if color parsing fails
    return isDark ? ABSOLUTE_WHITE : ABSOLUTE_BLACK;
  }
};

type Rgba = { r: number; g: number; b: number; a: number };

const parseRgba = (color: string): Rgba | undefined => {
  try {
    const { r, g, b, a } = new AggregationColor(color.trim()).toRgb();
    return { r, g, b, a };
  } catch {
    return undefined;
  }
};

/** Split a CSS value on commas that are not nested inside parentheses. */
const splitTopLevel = (value: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
};

const COLOR_TOKEN_PATTERN = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^()]*\)/gi;

/**
 * Resolve the solid color a CSS `background` value mostly paints.
 *
 * Plain colors are returned as-is. For gradients and layered backgrounds the
 * bottom-most layer (the last one in CSS order) is the base the others sit
 * on, so its color stops are averaged. Returns undefined when no color can be
 * found (images, `var()`, unknown keywords).
 */
export const resolveBackgroundBaseColor = (background: string): string | undefined => {
  const trimmed = background.trim();
  if (!trimmed) return undefined;
  // AggregationColor also accepts gradient strings (antd's gradient picker),
  // so only treat the value as a plain color when it isn't a gradient/image.
  const direct = /gradient|url\(|var\(/i.test(trimmed) ? undefined : parseRgba(trimmed);
  if (direct) return new AggregationColor(direct).toRgbString();

  const layers = splitTopLevel(trimmed);
  const baseLayer = layers[layers.length - 1] ?? trimmed;
  const stops = (baseLayer.match(COLOR_TOKEN_PATTERN) ?? [])
    .map(parseRgba)
    .filter((stop): stop is Rgba => stop !== undefined);
  if (stops.length === 0) return undefined;

  const sum = stops.reduce(
    (acc, stop) => ({
      r: acc.r + stop.r,
      g: acc.g + stop.g,
      b: acc.b + stop.b,
      a: acc.a + stop.a,
    }),
    { r: 0, g: 0, b: 0, a: 0 }
  );
  const count = stops.length;
  return new AggregationColor({
    r: Math.round(sum.r / count),
    g: Math.round(sum.g / count),
    b: Math.round(sum.b / count),
    a: sum.a / count,
  }).toRgbString();
};

/**
 * Alpha-composite `foreground` over `background` ("source over") and return
 * the resulting color. The background is treated as opaque, since it stands
 * for what is already painted behind the foreground. Returns undefined when
 * either color cannot be parsed.
 */
export const compositeColorOver = (foreground: string, background: string): string | undefined => {
  const fg = parseRgba(foreground);
  const bg = parseRgba(background);
  if (!fg || !bg) return undefined;
  const mix = (top: number, bottom: number) => Math.round(top * fg.a + bottom * (1 - fg.a));
  return new AggregationColor({
    r: mix(fg.r, bg.r),
    g: mix(fg.g, bg.g),
    b: mix(fg.b, bg.b),
    a: 1,
  }).toRgbString();
};
