/**
 * Where a mark goes.
 *
 * Pure arithmetic, deliberately separate from the components: a chart rendered
 * with `renderToStaticMarkup` is the only way this environment can see one, and
 * geometry that lives in JSX is geometry no test can reach. Everything here is
 * in a 0–100 viewBox so the SVG scales to whatever width the card gives it.
 */

/** The drawing area, inside the room the axis labels need. */
export interface Plot {
  width: number;
  height: number;
  /** Room for the value axis on the inline-start edge. */
  padStart: number;
  /** Room for the category axis along the bottom. */
  padBottom: number;
  padTop: number;
  padEnd: number;
}

export const PLOT: Plot = {
  width: 100,
  height: 46,
  padStart: 2,
  padEnd: 2,
  padTop: 3,
  // The x-axis band is inside the box, not below it: a container sized to the
  // plot alone gives the card its own little scrollbar.
  padBottom: 8,
};

/**
 * Room on the inline-end edge for a value written beside its bar.
 *
 * Sized from the longest label, because the longest bar reaches the full plot
 * width and its label is drawn past the end of it — straight out of the
 * viewBox, cropped, on exactly the row a reader most wants to read. Roughly
 * 1.15 viewBox units per character at the value font size, plus the gap.
 */
export function endRoomFor(labels: readonly string[], perCharacter = 1.15): number {
  const longest = labels.reduce((most, label) => Math.max(most, label.length), 0);
  return Math.min(40, longest * perCharacter + 1.5);
}

/** A plot with room reserved for labels written past the end of each bar. */
export const withEndRoom = (labels: readonly string[], plot: Plot = PLOT): Plot => ({
  ...plot,
  padEnd: Math.max(plot.padEnd, endRoomFor(labels)),
});

export const inner = (plot: Plot = PLOT) => ({
  x: plot.padStart,
  y: plot.padTop,
  width: plot.width - plot.padStart - plot.padEnd,
  height: plot.height - plot.padTop - plot.padBottom,
});

/**
 * The top of the value axis.
 *
 * Rounded up to something a person would say — 1, 2 or 5 times a power of ten —
 * so the gridlines land on readable numbers instead of on the maximum. Never
 * zero: an all-zero chart still needs a scale, or every bar divides by nothing.
 */
export function niceMax(values: readonly number[]): number {
  const peak = Math.max(0, ...values);
  if (peak <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const scaled = peak / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

export interface Bar {
  /** Inline-start edge, in viewBox units. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Vertical bars along a shared baseline.
 *
 * A two-unit gap between neighbours rather than a stroke around each one: a
 * border drawn to separate marks reads as chrome, a gap reads as nothing.
 */
export function columns(
  values: readonly number[],
  options: { max?: number; plot?: Plot; gap?: number } = {},
): Bar[] {
  const plot = options.plot ?? PLOT;
  const box = inner(plot);
  const max = options.max ?? niceMax(values);
  const gap = options.gap ?? 2;

  if (values.length === 0) return [];
  const slot = box.width / values.length;
  const width = Math.max(0.5, slot - gap);

  return values.map((value, index) => {
    // Clamped at zero: a negative bar hanging off a baseline this chart does
    // not draw would read as a very small positive one.
    const height = Math.max(0, Math.min(1, value / max)) * box.height;
    return {
      x: box.x + index * slot + (slot - width) / 2,
      y: box.y + box.height - height,
      width,
      height,
    };
  });
}

/** Horizontal bars, one per row, growing from the inline-start edge. */
export function rows(
  values: readonly number[],
  options: { max?: number; plot?: Plot; gap?: number } = {},
): Bar[] {
  const plot = options.plot ?? PLOT;
  const box = inner(plot);
  const max = options.max ?? niceMax(values);
  const gap = options.gap ?? 2;

  if (values.length === 0) return [];
  const slot = box.height / values.length;
  const height = Math.max(0.5, slot - gap);

  return values.map((value, index) => {
    const width = Math.max(0, Math.min(1, value / max)) * box.width;
    return {
      x: box.x,
      y: box.y + index * slot + (slot - height) / 2,
      // A nib rather than nothing. On a top-ten with one dominant row the tail
      // rendered as a column of floating numbers beside marks 0.07 of a pixel
      // wide — a row that is present in the data is a row with a mark.
      width: value > 0 ? Math.max(MIN_MARK, width) : 0,
      height,
    };
  });
}

/**
 * A polyline through one series.
 *
 * Points, not a path string, so a caller can put a marker on each one and a
 * test can read a coordinate without parsing SVG.
 */
export function line(
  values: readonly number[],
  options: { max?: number; plot?: Plot } = {},
): { x: number; y: number }[] {
  const plot = options.plot ?? PLOT;
  const box = inner(plot);
  const max = options.max ?? niceMax(values);

  if (values.length === 0) return [];

  return values.map((value, index) => ({
    x: dayX(index, values.length, plot),
    y: box.y + box.height - Math.max(0, Math.min(1, value / max)) * box.height,
  }));
}

/**
 * Where the nth of `count` days sits along the axis.
 *
 * The single source for the line's points, the day labels and the annotation
 * rules. They used to use three different formulas — the line spanning edge to
 * edge over `n − 1` gaps, the labels and the rules at the centres of `n` slots
 * — so every point was drawn half a slot from the day it belonged to, and an
 * annotation reading "the app arrived here" pointed somewhere else.
 */
export function dayX(index: number, count: number, plot: Plot = PLOT): number {
  const box = inner(plot);
  if (count <= 0) return box.x;
  if (count === 1) return box.x + box.width / 2;
  return box.x + (index * box.width) / (count - 1);
}

export const polyline = (points: readonly { x: number; y: number }[]): string =>
  points.map((point) => `${round(point.x)},${round(point.y)}`).join(" ");

/**
 * The shortest a bar may be and still be seen.
 *
 * Half a viewBox unit is about three pixels on a 660px card. A row whose value
 * is genuinely zero still draws nothing — the floor is for small, not for
 * absent.
 */
export const MIN_MARK = 0.5;

/** Two decimal places is finer than any screen renders, and keeps the DOM small. */
export const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Where the gridlines go.
 *
 * Four bands, always including zero and the top, so the reader has something to
 * measure against without a number on every mark.
 */
export function gridlines(plot: Plot = PLOT, bands = 4): number[] {
  const box = inner(plot);
  return Array.from(
    { length: bands + 1 },
    (_, index) => box.y + (box.height * index) / bands,
  );
}

/**
 * Which of many labels to actually draw.
 *
 * Thirty daily labels on a chart this wide collide into a grey smear. Every
 * nth is chosen so the first and the last are always drawn — the two a reader
 * uses to know what window they are looking at.
 */
export function labelStride(count: number, maximum = 7): number {
  if (count <= maximum) return 1;
  return Math.ceil((count - 1) / (maximum - 1));
}

export const shouldLabel = (index: number, count: number, maximum = 7): boolean =>
  index === 0 || index === count - 1 || index % labelStride(count, maximum) === 0;
