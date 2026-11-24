// A result as an Excel workbook (.xlsx), written by hand: an xlsx file is a
// zip of XML parts (ECMA-376, Office Open XML), and Node's zlib deflates
// and checksums them, so no library is needed.
//
// The parts are the fewest Excel opens without a repair: the content types,
// the package's and the workbook's relationships, the workbook, one sheet
// and its styles. Strings are written inline (`t="inlineStr"`), so there is
// no shared string table to build. The header row is bold and frozen.
//
// A number (a byte too) is a number and a boolean a boolean; a string in
// a general list is its characters. A temporal is Excel's own,
// a serial day since 1899-12-30 with a date or time format, so a sheet can
// compute with it: a date, a month (its first day), a timestamp and a
// datetime as dates, a timespan, minute, second and time as durations. One
// Excel cannot show - before 1900-03-01, or a negative duration - is
// written as q's text, as is an infinity and a long past 2^53, which Excel
// would round. A null is an empty cell. Excel holds 1,048,576 rows and
// 16,384 columns; a grid with more is cut there, and the notes say so.
import { deflateRawSync } from "node:zlib";
import type { GridPayload } from "./grid";
import { plainItem, rawColumn, textNull } from "./qliteral";
import { rankEdge, xlsxRules, type FormatRule } from "./resultlook";

/// One file of a zip: its name and its bytes.
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/// The CRC-32 a zip records of each file (ISO 3309), by table: zlib's own
/// `crc32` is newer than the Node of the oldest VS Code this runs in.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/// `entries` as a zip archive, each deflated, dated 1980-01-01 so the same
/// result gives the same bytes. No zip64: an archive past 4 GB is refused.
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // the name is UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(entry.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(head, name);
    offset += local.length + name.length + packed.length;
    if (offset > 0xffffffff) {
      throw new Error("the workbook is over 4 GB, more than a zip without zip64 holds");
    }
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/// Text as XML character data: markup escaped, and the characters XML 1.0
/// cannot hold at all dropped.
export function xmlText(text: string): string {
  return text
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// A column's letters in a cell reference: 0 is A, 26 is AA.
export function columnName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/// The day 2000.01.01, where q counts from, as an Excel serial.
const Q_EPOCH = 36526;
/// The first serial Excel shows as the date it is: 1900-03-01. Before it
/// lies the 1900-02-29 that never was.
const FIRST_SERIAL = 61;

/// The cell styles of styles.xml's cellXfs, by place.
const STYLE = { header: 1, date: 2, month: 3, stamp: 4, millis: 5, minute: 6, second: 7 } as const;

const STYLES = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<numFmts count="6">',
  '<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>',
  '<numFmt numFmtId="165" formatCode="yyyy\\-mm"/>',
  '<numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss.000"/>',
  '<numFmt numFmtId="167" formatCode="[h]:mm:ss.000"/>',
  '<numFmt numFmtId="168" formatCode="[h]:mm"/>',
  '<numFmt numFmtId="169" formatCode="[h]:mm:ss"/>',
  "</numFmts>",
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="8">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  ...[164, 165, 166, 167, 168, 169].map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`),
  "</cellXfs>",
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  "</styleSheet>",
].join("");

/// What one cell is written as: a number with a style, a boolean, a string,
/// or nothing (a null).
type Cell = { n: number; s?: number } | { b: boolean } | { t: string } | undefined;

/// A temporal's raw number - its own unit since 2000.01.01 - as a serial
/// and a style, or undefined when Excel cannot show it.
export function temporalSerial(type: number, raw: number): { n: number; s: number } | undefined {
  let n: number;
  let s: number;
  switch (type) {
    case 12:
      [n, s] = [raw / 864e11 + Q_EPOCH, STYLE.stamp];
      break;
    case 13: {
      const days = Date.UTC(2000 + Math.floor(raw / 12), ((raw % 12) + 12) % 12, 1) / 864e5 - Date.UTC(2000, 0, 1) / 864e5;
      [n, s] = [days + Q_EPOCH, STYLE.month];
      break;
    }
    case 14:
      [n, s] = [raw + Q_EPOCH, STYLE.date];
      break;
    case 15:
      [n, s] = [raw + Q_EPOCH, STYLE.stamp];
      break;
    case 16:
      [n, s] = [raw / 864e11, STYLE.millis];
      break;
    case 17:
      [n, s] = [raw / 1440, STYLE.minute];
      break;
    case 18:
      [n, s] = [raw / 86400, STYLE.second];
      break;
    case 19:
      [n, s] = [raw / 864e5, STYLE.millis];
      break;
    default:
      return undefined;
  }
  const isDate = type >= 12 && type <= 15;
  if (!Number.isFinite(n) || (isDate ? n < FIRST_SERIAL || n >= 2958466 : n < 0)) {
    return undefined;
  }
  return { n, s };
}

/// The cell for one value of a column of `type`.
export function xlsxCell(type: number, text: string, raw: unknown): Cell {
  if (raw === null || textNull(type, text)) {
    return undefined;
  }
  if ((raw === Infinity || raw === -Infinity) && type !== 0) {
    return { t: `${raw < 0 ? "-" : ""}0${type === 8 || type === 9 || type === 15 ? "w" : "W"}` };
  }
  if (type === 1) {
    return { b: text === "1" };
  }
  if (type === 4) {
    return { n: parseInt(text, 16) };
  }
  if (type >= 5 && type <= 9 && raw !== undefined) {
    const n = Number(raw);
    // A long Excel would round keeps its digits as text.
    return Number.isSafeInteger(n) || type >= 8 ? { n } : { t: String(raw) };
  }
  if (type >= 12 && type <= 19 && raw !== undefined) {
    return temporalSerial(type, Number(raw)) ?? { t: text };
  }
  // Excel's limit on a cell's text, one unit less when the cut would split
  // a surrogate pair (#1811), as assist's cut does.
  const plain = type === 0 ? plainItem(text) : text;
  const end = /[\uD800-\uDBFF]/.test(plain[32766] ?? "") ? 32766 : 32767;
  return { t: plain.length > 32767 ? plain.slice(0, end) : plain };
}

function cellXml(ref: string, cell: Cell): string {
  if (cell === undefined) {
    return "";
  }
  if ("n" in cell) {
    return `<c r="${ref}"${cell.s ? ` s="${cell.s}"` : ""}><v>${String(cell.n).replace("e+", "E+").replace("e-", "E-")}</v></c>`;
  }
  if ("b" in cell) {
    return `<c r="${ref}" t="b"><v>${cell.b ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.t)}</t></is></c>`;
}

const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;

/// The rows `order` of the payload as an xlsx workbook.
/// `rules`: conditional formatting rules (#1013), written as Excel's own.
export function toXlsx(payload: GridPayload, order: number[], rules: FormatRule[] = []): { data: Buffer; rows: number; notes: string[] } {
  const notes: string[] = [];
  const width = Math.min(payload.names.length, MAX_COLUMNS);
  if (width < payload.names.length) {
    notes.push(`Excel holds ${MAX_COLUMNS} columns: the last ${payload.names.length - width} were left out`);
  }
  const rows = order.slice(0, MAX_ROWS - 1);
  if (rows.length < order.length) {
    notes.push(`Excel holds ${MAX_ROWS.toLocaleString("en-US")} rows: the last ${(order.length - rows.length).toLocaleString("en-US")} were left out`);
  }
  const letters = [...Array(width).keys()].map(columnName);
  const raws = letters.map((_, i) => rawColumn(payload, i));
  const sheet: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    "<sheetData>",
    `<row r="1">${letters.map((l, i) => cellXml(`${l}1`, { t: payload.names[i] })).join("").replace(/<c /g, `<c s="${STYLE.header}" `)}</row>`,
  ];
  rows.forEach((r, k) => {
    const line = k + 2;
    const cells = letters.map((l, i) => {
      const raw = raws[i];
      return cellXml(`${l}${line}`, xlsxCell(payload.types[i], payload.cells[i][r] ?? "", raw === undefined ? undefined : raw[r]));
    });
    sheet.push(`<row r="${line}">${cells.join("")}</row>`);
  });
  const types = payload.types.slice(0, width);
  // Booleans, bytes and the temporal types are written as Excel values, not text.
  // A general list whose strings are written without their quotes is not
  // the text the grid's rules read (#1411).
  const text = types.map((t, i) => !(t === 1 || t === 4 || (t >= 5 && t <= 9) || (t >= 12 && t <= 19)) &&
    !(t === 0 && rows.some((r) => plainItem(payload.cells[i][r] ?? "") !== (payload.cells[i][r] ?? ""))));
  const formats = xlsxRules(rules, payload.names.slice(0, width), types.map((t) => t >= 5 && t <= 9), columnName, rows.length + 1, text, (rule, c) => rankEdge(payload, c, rule));
  sheet.push("</sheetData>", ...formats.formatting, "</worksheet>");
  const xml = (lines: string[]) => Buffer.from(lines.join(""), "utf8");
  const data = zip([
    {
      name: "[Content_Types].xml",
      data: xml([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        "</Types>",
      ]),
    },
    {
      name: "_rels/.rels",
      data: xml([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
        "</Relationships>",
      ]),
    },
    {
      name: "xl/workbook.xml",
      data: xml([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheets><sheet name="result" sheetId="1" r:id="rId1"/></sheets>',
        "</workbook>",
      ]),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: xml([
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
        "</Relationships>",
      ]),
    },
    { name: "xl/worksheets/sheet1.xml", data: xml(sheet) },
    {
      name: "xl/styles.xml",
      data: Buffer.from(formats.dxfs.length === 0 ? STYLES : STYLES.replace("</styleSheet>", `<dxfs count="${formats.dxfs.length}">${formats.dxfs.join("")}</dxfs></styleSheet>`), "utf8"),
    },
  ]);
  return { data, rows: rows.length, notes };
}
