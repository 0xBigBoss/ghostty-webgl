import {
  CellFlags,
  DirtyState,
  ROW_DIRTY,
  ROW_HAS_HYPERLINK,
  ROW_HAS_SELECTION,
  type GhosttyCell,
  type HyperlinkRange,
  type RenderInput,
  type TerminalTheme,
} from "./types";
import type { GlyphAtlas, GlyphMetrics } from "./GlyphAtlas";

const CELL_STRIDE = 32;
const GLYPH_COLOR_ATLAS = 0x01;

const DECO_UNDERLINE = 0x01;
const DECO_STRIKETHROUGH = 0x02;
const DECO_HYPERLINK = 0x04;
const _DECO_CURLY = 0x08;

const LINK_COLOR = { r: 74, g: 144, b: 226, a: 255 };

export class CellBuffer {
  private gl: WebGL2RenderingContext;
  private buffer: WebGLBuffer;
  private cols: number = 0;
  private rows: number = 0;
  private data: ArrayBuffer = new ArrayBuffer(0);
  private u8: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(new ArrayBuffer(0));

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error("Failed to create WebGL buffer");
    }
    this.buffer = buffer;
  }

  get handle(): WebGLBuffer {
    return this.buffer;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;

    const totalBytes = cols * rows * CELL_STRIDE;
    this.data = new ArrayBuffer(totalBytes);
    this.u8 = new Uint8Array(this.data);
    this.view = new DataView(this.data);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, totalBytes, this.gl.DYNAMIC_DRAW);
  }

  update(input: RenderInput, atlas: GlyphAtlas, forceFullUpload: boolean): void {
    if (input.cols !== this.cols || input.rows !== this.rows) {
      this.resize(input.cols, input.rows);
    }

    const rows = input.rows;
    const cols = input.cols;
    const rowFlags = input.rowFlags;
    const dirtyRows: number[] = [];
    const dirtyMask = ROW_DIRTY | ROW_HAS_SELECTION | ROW_HAS_HYPERLINK;

    if (forceFullUpload || input.dirtyState === DirtyState.FULL) {
      for (let y = 0; y < rows; y++) dirtyRows.push(y);
    } else {
      for (let y = 0; y < rows; y++) {
        if ((rowFlags[y] & dirtyMask) !== 0) {
          dirtyRows.push(y);
        }
      }
    }

    if (dirtyRows.length === 0) return;

    for (const row of dirtyRows) {
      this.writeRow(row, input, atlas);
    }

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    const rowSize = cols * CELL_STRIDE;
    if (dirtyRows.length > rows * 0.5 || forceFullUpload) {
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.u8, this.gl.DYNAMIC_DRAW);
    } else {
      for (const row of dirtyRows) {
        const offset = row * rowSize;
        this.gl.bufferSubData(
          this.gl.ARRAY_BUFFER,
          offset,
          this.u8.subarray(offset, offset + rowSize),
        );
      }
    }
  }

  private writeRow(row: number, input: RenderInput, atlas: GlyphAtlas): void {
    const cols = input.cols;
    const rowOffset = row * cols * CELL_STRIDE;
    const selectionRange = input.selectionRange;
    const hovered = input.hoveredLink;
    const theme = input.theme;

    for (let col = 0; col < cols; col++) {
      const cell = input.viewportCells[row * cols + col];
      const offset = rowOffset + col * CELL_STRIDE;
      if (!cell) {
        this.writeEmptyCell(offset);
        continue;
      }

      const cellSpan = cell.width === 0 ? 0 : cell.width;
      const isSelected = selectionRange ? isInSelection(col, row, selectionRange) : false;
      const isHovered =
        (hovered?.hyperlinkId ?? 0) > 0
          ? cell.hyperlink_id === hovered?.hyperlinkId
          : hovered?.range
            ? isInLinkRange(col, row, hovered.range)
            : false;

      const { fg, bg, fgA, bgA, decoColor, decoFlags } = resolveCellColors(
        cell,
        theme,
        isSelected,
        isHovered,
      );

      let glyphFlags = 0;
      let atlasMetrics: GlyphMetrics | null = null;
      if (cellSpan > 0 && fgA > 0 && !(cell.flags & CellFlags.INVISIBLE)) {
        let grapheme: string;
        if (cell.grapheme_len > 0) {
          grapheme = input.getGraphemeString(row, col);
        } else {
          grapheme = String.fromCodePoint(cell.codepoint || 32);
        }
        if (grapheme.trim().length > 0) {
          const bold = (cell.flags & CellFlags.BOLD) !== 0;
          const italic = (cell.flags & CellFlags.ITALIC) !== 0;
          atlasMetrics = atlas.getGlyph(grapheme, bold, italic);
          if (atlasMetrics.isColor) {
            glyphFlags |= GLYPH_COLOR_ATLAS;
          }
        }
      }

      const atlasX = atlasMetrics?.atlasX ?? 0;
      const atlasY = atlasMetrics?.atlasY ?? 0;
      const atlasW = atlasMetrics?.atlasW ?? 0;
      const atlasH = atlasMetrics?.atlasH ?? 0;
      const bearingX = atlasMetrics?.bearingX ?? 0;
      const bearingY = atlasMetrics?.bearingY ?? 0;

      this.view.setUint16(offset + 0, atlasX, true);
      this.view.setUint16(offset + 2, atlasY, true);
      this.view.setUint16(offset + 4, atlasW, true);
      this.view.setUint16(offset + 6, atlasH, true);
      this.view.setInt16(offset + 8, clampI16(bearingX), true);
      this.view.setInt16(offset + 10, clampI16(bearingY), true);

      this.u8[offset + 12] = cellSpan & 0xff;
      this.u8[offset + 13] = decoFlags & 0xff;
      this.u8[offset + 14] = glyphFlags & 0xff;
      this.u8[offset + 15] = 0;

      this.u8[offset + 16] = fg.r;
      this.u8[offset + 17] = fg.g;
      this.u8[offset + 18] = fg.b;
      this.u8[offset + 19] = fgA;

      this.u8[offset + 20] = bg.r;
      this.u8[offset + 21] = bg.g;
      this.u8[offset + 22] = bg.b;
      this.u8[offset + 23] = bgA;

      this.u8[offset + 24] = decoColor.r;
      this.u8[offset + 25] = decoColor.g;
      this.u8[offset + 26] = decoColor.b;
      this.u8[offset + 27] = decoColor.a;

      this.view.setUint32(offset + 28, 0, true);
    }
  }

  private writeEmptyCell(offset: number): void {
    this.view.setUint16(offset + 0, 0, true);
    this.view.setUint16(offset + 2, 0, true);
    this.view.setUint16(offset + 4, 0, true);
    this.view.setUint16(offset + 6, 0, true);
    this.view.setInt16(offset + 8, 0, true);
    this.view.setInt16(offset + 10, 0, true);
    this.u8[offset + 12] = 1;
    this.u8[offset + 13] = 0;
    this.u8[offset + 14] = 0;
    this.u8[offset + 15] = 0;
    this.u8[offset + 16] = 0;
    this.u8[offset + 17] = 0;
    this.u8[offset + 18] = 0;
    this.u8[offset + 19] = 0;
    this.u8[offset + 20] = 0;
    this.u8[offset + 21] = 0;
    this.u8[offset + 22] = 0;
    this.u8[offset + 23] = 0;
    this.u8[offset + 24] = 0;
    this.u8[offset + 25] = 0;
    this.u8[offset + 26] = 0;
    this.u8[offset + 27] = 0;
    this.view.setUint32(offset + 28, 0, true);
  }
}

function isInSelection(
  x: number,
  y: number,
  sel: NonNullable<RenderInput["selectionRange"]>,
): boolean {
  const { startCol, startRow, endCol, endRow } = sel;
  if (startRow === endRow) {
    return y === startRow && x >= startCol && x <= endCol;
  }
  if (y === startRow) return x >= startCol;
  if (y === endRow) return x <= endCol;
  return y > startRow && y < endRow;
}

function isInLinkRange(x: number, y: number, range: HyperlinkRange["range"]): boolean {
  if (!range) return false;
  return (
    (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
    (y > range.startY && y < range.endY) ||
    (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
  );
}

function resolveCellColors(
  cell: GhosttyCell,
  theme: TerminalTheme,
  isSelected: boolean,
  isHovered: boolean,
): {
  fg: { r: number; g: number; b: number };
  bg: { r: number; g: number; b: number };
  fgA: number;
  bgA: number;
  decoColor: { r: number; g: number; b: number; a: number };
  decoFlags: number;
} {
  let fg = { r: cell.fg_r, g: cell.fg_g, b: cell.fg_b };
  let bg = { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b };

  if (cell.flags & CellFlags.INVERSE) {
    const tmp = fg;
    fg = bg;
    bg = tmp;
  }

  let fgA = 255;
  if (cell.flags & CellFlags.INVISIBLE) {
    fgA = 0;
  } else if (cell.flags & CellFlags.FAINT) {
    fgA = 128;
  }

  const isDefaultBg = bg.r === 0 && bg.g === 0 && bg.b === 0;
  let bgA = isDefaultBg ? 0 : 255;

  if (isSelected) {
    const selectionOpacity = clampAlpha(theme.selectionOpacity * theme.selectionBackground.a);
    const baseBg = isDefaultBg
      ? { r: theme.background.r, g: theme.background.g, b: theme.background.b }
      : bg;
    bg = blendRgb(baseBg, theme.selectionBackground, selectionOpacity);
    bgA = 255;
    if (theme.selectionForeground) {
      fg = {
        r: theme.selectionForeground.r,
        g: theme.selectionForeground.g,
        b: theme.selectionForeground.b,
      };
    }
  }

  let decoFlags = 0;
  if (cell.flags & CellFlags.UNDERLINE) decoFlags |= DECO_UNDERLINE;
  if (cell.flags & CellFlags.STRIKETHROUGH) decoFlags |= DECO_STRIKETHROUGH;
  if (isHovered) decoFlags |= DECO_HYPERLINK;

  let decoColor = {
    r: fg.r,
    g: fg.g,
    b: fg.b,
    a: 255,
  };
  if (decoFlags & DECO_HYPERLINK) {
    decoColor = LINK_COLOR;
  }

  return { fg, bg, fgA, bgA, decoColor, decoFlags };
}

function blendRgb(
  base: { r: number; g: number; b: number },
  overlay: { r: number; g: number; b: number },
  opacity: number,
): { r: number; g: number; b: number } {
  const inv = 1 - opacity;
  return {
    r: clampU8(Math.round(base.r * inv + overlay.r * opacity)),
    g: clampU8(Math.round(base.g * inv + overlay.g * opacity)),
    b: clampU8(Math.round(base.b * inv + overlay.b * opacity)),
  };
}

function clampU8(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -32768) return -32768;
  if (value > 32767) return 32767;
  return Math.trunc(value);
}

function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
