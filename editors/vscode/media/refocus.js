// Keeping the keyboard focus over a redraw (#1340).
//
// A page here redraws by replacing its controls, and the control that held
// the focus goes with them: the focus falls back to the body, and the next
// Tab starts from the top of the page. A page names its controls as it
// makes them and redraws through `over`, and the control made under the
// name of the one that held the focus takes it.
//
// The dashboard, the q Plots view and the result page load this before
// their own script; test/refocus.test.js runs it under node. In a page it
// sets `qlintFocus` on the global object.
(function (root) {
  "use strict";

  /// The controls of `document`, by name: {name, each, over}.
  function keepFocus(document) {
    /// The control last made under each name, and the name of each control.
    const named = new Map();
    const names = new WeakMap();
    /// The name another takes the focus for, when it is drawn disabled or not at all.
    const instead = new Map();

    /// Names a control and returns it. `orElse` names the control that
    /// takes the focus when this one is redrawn disabled, or not at all.
    function name(control, key, orElse) {
      named.set(key, control);
      names.set(control, key);
      if (orElse !== undefined) {
        instead.set(key, orElse);
      }
      return control;
    }

    /// Names every button, select, input and textarea under `container` by
    /// its place among them and its kind: for controls that are drawn in
    /// the same order every time.
    function each(container, prefix) {
      let place = 0;
      const walk = function (e) {
        Array.from(e.children || []).forEach(function (c) {
          if (/^(BUTTON|SELECT|INPUT|TEXTAREA)$/.test(c.tagName)) {
            name(c, prefix + " " + place++ + " " + c.tagName + " " + (c.type || ""));
          }
          walk(c);
        });
      };
      walk(container);
    }

    /// Runs `redraw` and returns what it does. If the control that held the
    /// focus went with the redraw, the one made under its name takes it.
    function over(redraw) {
      const held = document.activeElement;
      const key = held ? names.get(held) : undefined;
      const out = redraw();
      // Still there, or the redraw put the focus somewhere itself: left alone.
      const now = document.activeElement;
      if (key === undefined || (now && now !== document.body)) {
        return out;
      }
      let next = named.get(key);
      if (!next || next === held || next.disabled) {
        next = named.get(instead.get(key));
      }
      if (next && next !== held && !next.disabled) {
        next.focus();
      }
      return out;
    }

    return { name: name, each: each, over: over };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { keepFocus: keepFocus };
  } else {
    root.qlintFocus = keepFocus(root.document);
  }
})(typeof self !== "undefined" ? self : this);
