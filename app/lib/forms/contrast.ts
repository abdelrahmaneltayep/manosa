/**
 * WCAG contrast, so the Appearance tab can say "this grey fails on white".
 *
 * Pure, and small on purpose: the whole point is that a merchant picking a
 * brand colour finds out in the builder rather than from a buyer who cannot
 * read the form.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` or `#rrggbb`, with or without the hash. Null if it is neither. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0]! + hex[0]!, 16),
      g: parseInt(hex[1]! + hex[1]!, 16),
      b: parseInt(hex[2]! + hex[2]!, 16),
    };
  }

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  return null;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  );
}

/** WCAG 2.1 contrast ratio, 1–21. Null when either colour is unreadable. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return null;

  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a > b ? [a, b] : [b, a];

  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastVerdict {
  ratio: number | null;
  /** 4.5:1 for body text, 3:1 for large text. */
  passesAA: boolean;
  /** Null when a colour could not be read at all. */
  unreadable: boolean;
}

export function checkContrast(
  foreground: string,
  background: string,
  large = false,
): ContrastVerdict {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null) return { ratio: null, passesAA: false, unreadable: true };

  // Rounded to one decimal first: 4.4995 displayed as "4.5" but reported as a
  // failure is a contradiction the merchant cannot act on.
  const rounded = Math.round(ratio * 10) / 10;
  return {
    ratio: rounded,
    passesAA: rounded >= (large ? 3 : 4.5),
    unreadable: false,
  };
}
