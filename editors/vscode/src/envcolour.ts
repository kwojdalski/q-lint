// The environment colour (#1035), as data: which colour a connected
// process's tags give it, and how that colour is drawn - a status bar item
// and a border down the left of each q editor while it is the active
// process. No `vscode` import, so node tests it; `envcolourview.ts` draws.
//
// Off unless turned on, as it recolours the window. The colours come from
// `q-lint.processes.environmentColor.colors`, tag to colour: a name (red,
// amber, yellow, green, blue, purple) or `#rrggbb`. By default production
// tags are red and `uat` amber. A process with tags of two colours takes
// the most cautious: red, amber, yellow, purple, blue, green, then any
// `#rrggbb`.

export const ENV_COLOUR_NAMES = ["red", "amber", "yellow", "purple", "blue", "green"] as const;
export type EnvColourName = (typeof ENV_COLOUR_NAMES)[number];

export const DEFAULT_ENV_COLOURS: Record<string, string> = { prod: "red", prd: "red", production: "red", uat: "amber" };

const HEX = /^#[0-9a-f]{6}$/i;

/// `q-lint.processes.environmentColor.colors` as written: tag (lower case)
/// to a colour name or `#rrggbb`; anything else dropped. Not an object: the
/// defaults.
export function readEnvColours(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_ENV_COLOURS };
  }
  const out: Record<string, string> = {};
  for (const [tag, colour] of Object.entries(value as Record<string, unknown>)) {
    const key = tag.trim().toLowerCase();
    const c = typeof colour === "string" ? colour.trim().toLowerCase() : "";
    if (key !== "" && (ENV_COLOUR_NAMES.includes(c as EnvColourName) || HEX.test(c))) {
      Object.defineProperty(out, key, { value: c, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/// The colour `tags` give, and the tag it came from: the most cautious.
export function envColourOf(tags: string[], colours: Record<string, string>): { tag: string; colour: string } | undefined {
  const found = tags
    .map((tag) => ({ tag, colour: Object.prototype.hasOwnProperty.call(colours, tag.toLowerCase()) ? colours[tag.toLowerCase()] : undefined }))
    .filter((f): f is { tag: string; colour: string } => f.colour !== undefined);
  const rank = (c: string): number => {
    const i = ENV_COLOUR_NAMES.indexOf(c as EnvColourName);
    return i < 0 ? ENV_COLOUR_NAMES.length : i;
  };
  return found.sort((a, b) => rank(a.colour) - rank(b.colour))[0];
}

/// How a colour is drawn: the status bar item's background (only the error
/// and warning ones are allowed there), a ThemeColor id or `#rrggbb` for
/// the border and the item's text.
export function envPaint(colour: string): { background?: "statusBarItem.errorBackground" | "statusBarItem.warningBackground"; theme?: string; hex?: string } {
  switch (colour) {
    case "red":
      return { background: "statusBarItem.errorBackground", theme: "charts.red" };
    case "amber":
      return { background: "statusBarItem.warningBackground", theme: "charts.orange" };
    case "yellow":
      return { background: "statusBarItem.warningBackground", theme: "charts.yellow" };
    case "purple":
    case "blue":
    case "green":
      return { theme: `charts.${colour}` };
    default:
      return HEX.test(colour) ? { hex: colour } : {};
  }
}
