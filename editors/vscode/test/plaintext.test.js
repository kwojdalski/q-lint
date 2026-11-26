// Text from a q process shown as written where VS Code would read it as
// markup: a notification's `[label](command:...)` link (#1306), a status
// bar's or a quick pick's `$(icon)` (#1313, #1314).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { plainMessage } = require("../out/history.js");

// VS Code's own pattern for a link in a notification (vs/base/common/linkedText.ts).
const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

test("a notification's text holds no link VS Code would follow (#1306)", () => {
  const evil = "'[Open](command:workbench.action.terminal.new) and [x](https://e.io)";
  assert.match(evil, LINK);
  assert.doesNotMatch(plainMessage(evil), LINK);
  assert.strictEqual(plainMessage(evil).replace(/​/g, ""), evil);
  assert.strictEqual(plainMessage("a [b] (c)"), "a [b] (c)");
});

/// Every call `window.<method>(first, ...)` in src whose first argument is
/// neither a literal, a constant nor `wrapper(...)`.
function unwrapped(method, wrapper, at = (call) => call.arguments[0]) {
  const found = [];
  const dir = path.join(__dirname, "..", "src");
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const sf = ts.createSourceFile(name, fs.readFileSync(path.join(dir, name), "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && method.test(node.expression.name.text) && /(^|\.)window$/.test(node.expression.expression.getText(sf))) {
        const a = at(node);
        const plain =
          a === undefined ||
          ts.isStringLiteral(a) ||
          ts.isNoSubstitutionTemplateLiteral(a) ||
          (ts.isIdentifier(a) && /^[A-Z][A-Z0-9_]*$/.test(a.text)) ||
          (ts.isCallExpression(a) && a.expression.getText(sf) === wrapper);
        if (!plain) {
          found.push(`${name}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

test("every notification built from values passes through plainMessage (#1306)", () => {
  assert.deepStrictEqual(unwrapped(/^show(Information|Warning|Error)Message$/, "plainMessage"), []);
});

/// Where a Notification-located `window.withProgress` gets text from
/// values: its title, and the message of every `report` inside its task.
function progressTexts(node, sf) {
  const [options, task] = node.arguments;
  if (options === undefined || !ts.isObjectLiteralExpression(options) || !/ProgressLocation\.Notification/.test(options.getText(sf))) {
    return [];
  }
  const texts = [];
  const value = (literal, key) => {
    const p = literal.properties.find((q) => q.name !== undefined && q.name.getText(sf) === key);
    return p === undefined ? undefined : ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
  };
  texts.push(value(options, "title"));
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "report" && n.arguments[0] !== undefined && ts.isObjectLiteralExpression(n.arguments[0])) {
      texts.push(value(n.arguments[0], "message"));
    }
    ts.forEachChild(n, visit);
  };
  if (task !== undefined) {
    visit(task);
  }
  return texts.filter((t) => t !== undefined);
}

test("every progress notification's title and message pass through plainMessage (#2654, #2655)", () => {
  const found = [];
  const dir = path.join(__dirname, "..", "src");
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const sf = ts.createSourceFile(name, fs.readFileSync(path.join(dir, name), "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "withProgress") {
        for (const a of progressTexts(node, sf)) {
          const plain = ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || (ts.isCallExpression(a) && a.expression.getText(sf) === "plainMessage");
          if (!plain) {
            found.push(`${name}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepStrictEqual(found, []);
});
