// The result panel's further charts: an order book's depth (#1016), points
// on a map of the world (#1017), and linked time-series panes (#1018).
//
// As chartspec.js, nothing here touches the DOM or Chart.js itself: each
// chart is its data, its Chart.js configuration and its SVG, from a
// `grid.ts` Grid and a theme the caller read. result.js loads it after
// chartspec.js and gridlook.js, and test/resultcharts.test.js runs it under
// node. In a page it sets `qlintChartMore` on the global object.
(function (root) {
  "use strict";

  const node = typeof module !== "undefined" && module.exports;
  const C = node ? require("./chartspec.js") : root.qlintChart;
  const L = node ? require("./gridlook.js") : root.qlintLook;

  /// A column's name as the charts match it: lower case, without `_`.
  function key(name) {
    return String(name).toLowerCase().replace(/_/g, "");
  }

  /// The first column whose name is one of `names` and that `test` accepts.
  function find(grid, names, test) {
    return grid.columns.findIndex(function (c, i) { return names.indexOf(key(c.name)) >= 0 && test(c, i); });
  }

  // --- order book depth (#1016)

  const BID_PRICE = ["bid", "bidprice", "bidpx", "bidprc", "bp", "bpx", "bids", "bidprices"];
  const BID_SIZE = ["bidsize", "bidqty", "bidsz", "bidvol", "bidvolume", "bidamount", "bidquantity", "bs", "bsize", "bqty", "bidsizes", "bidqtys"];
  const ASK_PRICE = ["ask", "askprice", "askpx", "askprc", "ap", "apx", "asks", "askprices", "offer", "offerprice", "offerpx", "offers"];
  const ASK_SIZE = ["asksize", "askqty", "asksz", "askvol", "askvolume", "askamount", "askquantity", "as", "asize", "aqty", "asksizes", "askqtys", "offersize", "offerqty", "offersizes"];
  const SIDE = ["side", "buysell", "direction"];
  const PRICE = ["price", "px", "prc"];
  const SIZE = ["size", "qty", "quantity", "sz", "vol", "volume", "amount"];
  const BUY = /^(b|bid|bids|buy)$/i;
  const SELL = /^(a|s|ask|asks|sell|offer)$/i;

  /// The columns an order book is read from, or null when the grid holds
  /// none: {mode, bp, bs, ap, as} - `levels`, one level a row in numeric
  /// bid and ask price and size columns; `lists`, a row's levels in
  /// columns of numeric lists - or {mode: "sides", side, price, size}, a
  /// row a level with its side (`buy`/`bid`/`b` or `sell`/`ask`/`a`).
  function depthColumns(grid) {
    const numeric = function (c) { return c.numeric; };
    const list = function (c, i) { return L.isNumericList(grid, i); };
    const four = function (test) {
      const at = [BID_PRICE, BID_SIZE, ASK_PRICE, ASK_SIZE].map(function (names) { return find(grid, names, test); });
      return at.every(function (i) { return i >= 0; }) ? at : null;
    };
    const levels = four(numeric);
    if (levels) {
      return { mode: "levels", bp: levels[0], bs: levels[1], ap: levels[2], as: levels[3] };
    }
    const lists = four(list);
    if (lists) {
      return { mode: "lists", bp: lists[0], bs: lists[1], ap: lists[2], as: lists[3] };
    }
    const side = find(grid, SIDE, function (c) { return !c.numeric; });
    const price = find(grid, PRICE, numeric);
    const size = find(grid, SIZE, numeric);
    return side >= 0 && price >= 0 && size >= 0 ? { mode: "sides", side: side, price: price, size: size } : null;
  }

  /// The book over `rows`: {bids, asks}, each [price, size] pairs with
  /// neither null and a size above zero, and the row read when the levels
  /// are lists (the first shown). Null when the grid holds no book.
  /// `unsided` counts the rows whose side is neither buy nor sell (`1b`,
  /// `long`): they are in no level, which is said, not kept quiet (#3144).
  function depthBook(grid, rows) {
    const cols = depthColumns(grid);
    if (!cols) {
      return null;
    }
    const bids = [];
    const asks = [];
    const add = function (into, p, s) {
      if (p !== null && s !== null && p !== undefined && s !== undefined && isFinite(p) && isFinite(s) && s > 0) {
        into.push([p, s]);
      }
    };
    const v = function (c, r) { return grid.values[c][r]; };
    if (cols.mode === "levels") {
      rows.forEach(function (r) {
        add(bids, v(cols.bp, r), v(cols.bs, r));
        add(asks, v(cols.ap, r), v(cols.as, r));
      });
      return { mode: "levels", bids: bids, asks: asks };
    }
    if (cols.mode === "lists") {
      if (rows.length === 0) {
        return { mode: "lists", bids: bids, asks: asks };
      }
      const r = rows[0];
      // A cell's numbers as GRID sent them where it did (a float or real
      // vector), its text otherwise: `-3!` text, cut at the process's `\c`
      // width, which then drops the levels past it (#2465).
      let cut = false;
      const read = function (c) {
        const sent = grid.vectors && grid.vectors[c] ? grid.vectors[c][r] : null;
        if (sent) {
          return sent;
        }
        cut = cut || /\.\.\.?$/.test(String(grid.cells[c][r]).trim());
        return L.parseNumbers(grid.cells[c][r]) || [];
      };
      const bp = read(cols.bp);
      const bs = read(cols.bs);
      const ap = read(cols.ap);
      const as = read(cols.as);
      bp.forEach(function (p, i) { add(bids, p, bs[i]); });
      ap.forEach(function (p, i) { add(asks, p, as[i]); });
      return Object.assign({ mode: "lists", row: r, bids: bids, asks: asks }, cut ? { cut: true } : {});
    }
    let unsided = 0;
    rows.forEach(function (r) {
      // A symbol shows as buy or `buy, a string as "buy" (one character ,"b").
      const side = grid.cells[cols.side][r].replace(/^`/, "").replace(/^,?"(.*)"$/, "$1");
      const into = BUY.test(side) ? bids : SELL.test(side) ? asks : null;
      if (into) {
        add(into, v(cols.price, r), v(cols.size, r));
      } else {
        unsided++;
      }
    });
    return { mode: "sides", bids: bids, asks: asks, unsided: unsided };
  }

  /// "12 rows have a side that is neither buy nor sell".
  function unsidedText(n) {
    return n.toLocaleString("en-US") + (n === 1 ? " row has" : " rows have") + " a side that is neither buy nor sell";
  }

  /// Whether a result is drawn as a depth chart by itself: its columns are
  /// a book's (depthColumns) and its rows read as one book. Not a history -
  /// quotes or trades, a row a time under a first column of times - whose
  /// rows piled into one book gave a mid and a spread of -0.1 from the
  /// whole of it (#3124); nor rows that cross, bids at or above asks, as a
  /// history's do; nor a book with no level, as where no row's side is buy
  /// or sell (#3144). Depth stays a kind to choose for each of them.
  function depthByItself(grid) {
    const cols = depthColumns(grid);
    if (!cols || (cols.mode !== "lists" && grid.columns[0].temporal)) {
      return false;
    }
    const rows = [];
    for (let r = 0; r < grid.cells[0].length; r++) {
      rows.push(r);
    }
    const book = depthBook(grid, rows);
    const bid = book.bids.reduce(function (m, l) { return Math.max(m, l[0]); }, -Infinity);
    const ask = book.asks.reduce(function (m, l) { return Math.min(m, l[0]); }, Infinity);
    return book.bids.length + book.asks.length > 0 && bid < ask;
  }

  /// Sizes at one price summed, each side from its best price out, with
  /// the size there and further: [[price, cumulative]], bids from the
  /// highest, asks from the lowest.
  function cumulative(levels, descending) {
    const at = new Map();
    levels.forEach(function (l) { at.set(l[0], (at.get(l[0]) || 0) + l[1]); });
    const prices = Array.from(at.keys()).sort(function (a, b) { return descending ? b - a : a - b; });
    let sum = 0;
    return prices.map(function (p) {
      sum += at.get(p);
      return [p, sum];
    });
  }

  /// What a depth chart of `rows` draws: {type, depth, datasets, mid,
  /// spread, unsided, note?}. The bid side is a step falling to the mid, the ask side
  /// one rising from it, each point {x: price, y: the size at that price
  /// and beyond}, in rising price, and `levels` the prices it has.
  function depthData(grid, rows) {
    const book = depthBook(grid, rows);
    if (!book) {
      return { type: "line", depth: true, datasets: [], note: "A depth chart needs an order book: bid and ask price and size columns (by level, or as lists), or side, price and size columns." };
    }
    const bids = cumulative(book.bids, true);
    const asks = cumulative(book.asks, false);
    if (bids.length === 0 && asks.length === 0) {
      return { type: "line", depth: true, datasets: [], note: book.unsided ? "The order book is empty: " + unsidedText(book.unsided) + " (buy is b, bid or buy; sell is a, s, ask, sell or offer)." : "The order book is empty: no level has a price and a size above zero." };
    }
    const best = { bid: bids.length ? bids[0][0] : null, ask: asks.length ? asks[0][0] : null };
    const mid = best.bid !== null && best.ask !== null ? (best.bid + best.ask) / 2 : null;
    // Each side runs on past its last level at its whole size, so the last
    // step shows: a twentieth of the prices' range further out, or the spread.
    const prices = bids.concat(asks).map(function (p) { return p[0]; });
    // A loop, not Math.max.apply: a book of 65k+ prices overflows the stack.
    const range = prices.reduce(function (m, p) { return Math.max(m, p); }, -Infinity) - prices.reduce(function (m, p) { return Math.min(m, p); }, Infinity);
    const out = range > 0 ? range / 20 : Math.abs(best.bid !== null && best.ask !== null ? best.ask - best.bid : 0) || Math.abs(prices[0]) / 100 || 1;
    const bidLine = bids.length ? [[bids[bids.length - 1][0] - out, bids[bids.length - 1][1]]].concat(bids.slice().reverse()) : [];
    const askLine = asks.length ? asks.concat([[asks[asks.length - 1][0] + out, asks[asks.length - 1][1]]]) : [];
    return {
      type: "line",
      depth: true,
      mode: book.mode,
      row: book.row,
      cut: book.cut === true,
      unsided: book.unsided || 0,
      mid: mid,
      spread: best.bid !== null && best.ask !== null ? best.ask - best.bid : null,
      datasets: [
        { label: "bid", side: "bid", stepped: "before", levels: bids.length, data: bidLine.map(function (p) { return { x: p[0], y: p[1] }; }) },
        { label: "ask", side: "ask", stepped: "after", levels: asks.length, data: askLine.map(function (p) { return { x: p[0], y: p[1] }; }) },
      ],
    };
  }

  /// A depth chart's line over it: the mid and the spread.
  function depthTitle(data) {
    if (data.mid === null || data.mid === undefined) {
      return "";
    }
    return "mid " + C.short(data.mid, data.spread || 0) + " · spread " + C.short(data.spread, data.spread / 10 || 0);
  }

  /// Chart.js's configuration for a depthData(): the bid side green, the
  /// ask side red, each filled down to zero, on a price axis.
  function depthConfig(data, look) {
    const colour = { bid: look.up || "#89d185", ask: look.down || "#f14c4c" };
    const translucent = function (c) { return /^#[0-9a-f]{6}$/i.test(c) ? c + "55" : c; };
    return {
      type: "line",
      data: {
        // `stepped` is in the SVG's sense ("before": rise, then run on);
        // Chart.js reads each name the other way round.
        datasets: data.datasets.map(function (d) {
          return Object.assign({}, d, { stepped: d.stepped === "before" ? "after" : "before", borderColor: colour[d.side], backgroundColor: translucent(colour[d.side]), fill: "origin", pointRadius: 0, borderWidth: 1.5 });
        }),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: { type: "linear", title: { display: true, text: "price" } },
          y: { beginAtZero: true, title: { display: true, text: "cumulative size" } },
        },
        plugins: {
          title: { display: Boolean(depthTitle(data)), text: depthTitle(data) },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + " " + ctx.raw.x + ": " + ctx.raw.y; } } },
        },
      },
    };
  }

  // --- map (#1017)

  const LAT = ["lat", "latitude"];
  const LON = ["lon", "lng", "long", "longitude"];

  /// The latitude and longitude columns, {lat, lon}, or null: numeric
  /// columns named lat or latitude, and lon, lng, long or longitude.
  function mapColumns(grid) {
    const numeric = function (c) { return c.numeric; };
    const lat = find(grid, LAT, numeric);
    const lon = find(grid, LON, numeric);
    return lat >= 0 && lon >= 0 ? { lat: lat, lon: lon } : null;
  }

  /// A "#rrggbb" colour as [r, g, b], or null.
  function rgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  /// The colour `t` (0 to 1) of the way from `a` to `b`, both "#rrggbb";
  /// `a` when either is not one.
  function blend(a, b, t) {
    const x = rgb(a);
    const y = rgb(b);
    if (!x || !y) {
      return a;
    }
    return "#" + x.map(function (v, i) { return Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0"); }).join("");
  }

  /// What a map of `rows` draws: {type, map, datasets: [{label, data,
  /// colours}], legend, dropped, note?}. Each point {x: longitude, y:
  /// latitude, r, row}. `size`: a numeric column whose square root scales
  /// the points from 3 to 15 pixels; `colour`: a column whose value colours
  /// them, a numeric one from the theme's first colour to its fourth, any
  /// other one colour per value. -1 for neither. Rows with no position,
  /// or one off the map, are dropped and counted.
  function mapData(grid, rows, opts, look) {
    const cols = mapColumns(grid);
    if (!cols) {
      return { type: "bubble", map: true, datasets: [], note: "A map needs latitude and longitude columns: numeric ones named lat or latitude, and lon, lng, long or longitude." };
    }
    const size = opts && opts.size >= 0 && grid.columns[opts.size] && grid.columns[opts.size].numeric ? opts.size : -1;
    const colour = opts && opts.colour >= 0 && grid.columns[opts.colour] ? opts.colour : -1;
    const palette = look.colours;
    const kept = [];
    let dropped = 0;
    rows.forEach(function (r) {
      const lat = grid.values[cols.lat][r];
      const lon = grid.values[cols.lon][r];
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        dropped++;
      } else {
        kept.push(r);
      }
    });
    const range = function (c) {
      let lo = Infinity;
      let hi = -Infinity;
      kept.forEach(function (r) {
        const v = grid.values[c][r];
        if (v !== null) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      });
      return { lo: lo, hi: hi };
    };
    const sized = size >= 0 ? range(size) : null;
    const radius = function (r) {
      if (!sized) {
        return 4;
      }
      const v = grid.values[size][r];
      if (v === null) {
        return 2;
      }
      return sized.hi > sized.lo ? 3 + 12 * Math.sqrt((v - sized.lo) / (sized.hi - sized.lo)) : 8;
    };
    let colourOf = function () { return palette[0]; };
    const legend = [];
    if (colour >= 0 && grid.columns[colour].numeric) {
      const span = range(colour);
      // One value alone is the legend's one entry, and drawn in its colour:
      // there is no range for it to be the middle of (#1948).
      colourOf = function (r) {
        const v = grid.values[colour][r];
        return v === null ? "#808080" : span.hi > span.lo ? blend(palette[0], palette[3], (v - span.lo) / (span.hi - span.lo)) : palette[0];
      };
      if (span.lo <= span.hi) {
        legend.push({ label: grid.columns[colour].name + " " + grid.cells[colour][kept.find(function (r) { return grid.values[colour][r] === span.lo; })], colour: palette[0] });
      }
      if (span.lo < span.hi) {
        legend.push({ label: grid.columns[colour].name + " " + grid.cells[colour][kept.find(function (r) { return grid.values[colour][r] === span.hi; })], colour: blend(palette[0], palette[3], 1) });
      }
    } else if (colour >= 0) {
      const seen = new Map();
      kept.forEach(function (r) {
        const t = grid.cells[colour][r];
        if (!seen.has(t)) {
          seen.set(t, palette[seen.size % palette.length]);
        }
      });
      seen.forEach(function (c, t) {
        if (legend.length < 12) {
          legend.push({ label: t === "" ? "(null)" : t, colour: c });
        }
      });
      colourOf = function (r) { return seen.get(grid.cells[colour][r]); };
    }
    const data = kept.map(function (r) { return { x: grid.values[cols.lon][r], y: grid.values[cols.lat][r], r: radius(r), row: r }; });
    const out = {
      type: "bubble",
      map: true,
      lat: cols.lat,
      lon: cols.lon,
      size: size,
      colour: colour,
      legend: legend,
      dropped: dropped,
      datasets: [{ label: grid.columns[cols.lat].name + ", " + grid.columns[cols.lon].name, data: data, colours: kept.map(colourOf) }],
    };
    if (data.length === 0) {
      out.note = "No row has a latitude and longitude on the map.";
    }
    return out;
  }

  /// Chart.js's configuration for a mapData(): the world's outline drawn
  /// under the points by a plugin, on a plain longitude-latitude grid, twice
  /// as wide as it is tall. `world`: {RINGS, SCALE}, worldoutline.js's.
  function mapConfig(grid, data, look, world) {
    const translucent = function (c) { return /^#[0-9a-f]{6}$/i.test(c) ? c + "bb" : c; };
    const outline = {
      id: "qlintWorld",
      beforeDatasetsDraw: function (chart) {
        const x = chart.scales.x;
        const y = chart.scales.y;
        const ctx = chart.ctx;
        ctx.save();
        ctx.beginPath();
        world.RINGS.forEach(function (ring) {
          for (let i = 0; i < ring.length; i += 2) {
            const px = x.getPixelForValue(ring[i] / world.SCALE);
            const py = y.getPixelForValue(ring[i + 1] / world.SCALE);
            if (i === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          }
          ctx.closePath();
        });
        ctx.fillStyle = look.land || "rgba(128,128,128,0.18)";
        ctx.strokeStyle = look.border;
        ctx.lineWidth = 0.6;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      },
    };
    const extra = function (r) {
      const parts = [];
      [data.size, data.colour].forEach(function (c) {
        if (c >= 0 && parts.indexOf(c) < 0) {
          parts.push(c);
        }
      });
      return parts.map(function (c) { return grid.columns[c].name + " " + grid.cells[c][r]; }).join(", ");
    };
    return {
      type: "bubble",
      data: {
        datasets: data.datasets.map(function (d) {
          return Object.assign({}, d, { backgroundColor: d.colours.map(translucent), borderColor: d.colours, borderWidth: 1 });
        }),
      },
      plugins: [outline],
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 2,
        scales: {
          x: { type: "linear", min: -180, max: 180, ticks: { stepSize: 60 }, title: { display: true, text: "longitude" } },
          y: { type: "linear", min: -90, max: 90, ticks: { stepSize: 30 }, title: { display: true, text: "latitude" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const r = ctx.raw.row;
                const more = extra(r);
                return grid.cells[data.lat][r] + ", " + grid.cells[data.lon][r] + (more ? "  " + more : "");
              },
            },
          },
        },
      },
    };
  }

  // --- linked time-series panes (#1018)

  /// What linked panes of `rows` draw: one pane per column of `columns`,
  /// each its points {x, y, row} in rising x, on the first column's values
  /// (a numeric or temporal one), or else the rows' numbers. {x: the x
  /// column, or -1, panes, note?}.
  function linkedData(grid, rows, columns) {
    const first = grid.columns[0];
    const x = grid.columns.length > 1 && first && (first.numeric || first.temporal) && grid.values[0] ? 0 : -1;
    if (columns.length === 0) {
      return { x: x, panes: [], note: "No numeric column to chart against the first." };
    }
    const xs = function (r, k) { return x >= 0 ? grid.values[0][r] : k; };
    const panes = columns.map(function (c) {
      const data = [];
      rows.forEach(function (r, k) {
        const xv = xs(r, k);
        const y = grid.values[c][r];
        if (xv !== null && xv !== undefined) {
          data.push({ x: xv, y: y, row: r });
        }
      });
      data.sort(function (a, b) { return a.x - b.x; });
      return { label: grid.columns[c].name, column: c, data: data };
    });
    return { x: x, panes: panes };
  }

  /// The place in `points` (rising x) of the one nearest `x`, or -1.
  function nearestIndex(points, x) {
    if (points.length === 0 || x === null || !isFinite(x)) {
      return -1;
    }
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].x < x) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo > 0 && Math.abs(points[lo - 1].x - x) <= Math.abs(points[lo].x - x) ? lo - 1 : lo;
  }

  /// How the x axis writes `v`, its value: q's notation for a temporal, a
  /// short number otherwise. `step`: the distance between ticks.
  function xText(grid, data, v, step) {
    if (data.x >= 0 && grid.columns[0].temporal) {
      return C.temporalLabel(grid.columns[0].type, v, step || 0);
    }
    return C.short(v, step || 0);
  }

  /// Whether the x axis is a temporal q holds in whole units (a date, a
  /// month, a minute, a second), so ticks between two are not drawn.
  function wholeX(grid, data) {
    return data.x >= 0 && Boolean(grid.columns[0].temporal) && C.WHOLE.indexOf(grid.columns[0].type) >= 0;
  }

  /// What the crosshair reads at `x`: the x, as its cell shows it, and each
  /// pane's value at its nearest point. {x, values: [{label, text}]}.
  function readout(grid, data, x) {
    const values = data.panes.map(function (p) {
      const i = nearestIndex(p.data, x);
      return { label: p.label, text: i < 0 ? "" : grid.cells[p.column][p.data[i].row] };
    });
    const any = data.panes.map(function (p) { return p.data[nearestIndex(p.data, x)]; }).find(Boolean);
    const xs = !any ? "" : data.x >= 0 ? grid.cells[0][any.row] : String(any.x);
    return { x: xs, values: values };
  }

  /// The x range a drag from `a` to `b` zooms to, or null for a click (a
  /// drag under 1/200 of `full`, the range shown).
  function zoomRange(a, b, full) {
    if (a === null || b === null || !isFinite(a) || !isFinite(b)) {
      return null;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return hi - lo <= Math.abs(full || 0) / 200 ? null : { min: lo, max: hi };
  }

  /// `range`, a zoom, while it meets the x that the points of `data`, a
  /// linkedData(), span; null once they have moved out of it, as those of a
  /// query run again for a later window have: every pane was empty (#3128).
  function zoomOver(data, range) {
    let lo = Infinity;
    let hi = -Infinity;
    data.panes.forEach(function (p) {
      p.data.forEach(function (pt) {
        if (pt.y !== null && isFinite(pt.y)) {
          lo = Math.min(lo, pt.x);
          hi = Math.max(hi, pt.x);
        }
      });
    });
    return range && lo <= hi && (range.max < lo || range.min > hi) ? null : range || null;
  }

  /// The points of a pane (rising x) inside `range` ({min, max}), or all of
  /// them, and a point where its line crosses an edge of the range: on
  /// screen a zoomed pane clips the line at its edges, so that it runs
  /// through, where the points inside alone left a gap to each edge, or
  /// nothing between two points (#3130).
  function inRange(points, range) {
    if (!range) {
      return points;
    }
    const valued = function (p) { return p.y !== null && isFinite(p.y); };
    const out = [];
    points.forEach(function (p, i) {
      const from = points[i - 1];
      if (from && valued(from) && valued(p)) {
        [range.min, range.max].forEach(function (edge) {
          if (from.x < edge && p.x > edge) {
            out.push({ x: edge, y: from.y + ((p.y - from.y) * (edge - from.x)) / (p.x - from.x) });
          }
        });
      }
      if (p.x >= range.min && p.x <= range.max) {
        out.push(p);
      }
    });
    return out;
  }

  /// Chart.js's configuration for one pane of a linkedData(): its series
  /// as a line in `colour` on a linear x axis shared with the others -
  /// `view.range` the zoom, `view.cursor` the crosshair's x, read when the
  /// chart draws - with the x labels only on the last pane.
  function linkedConfig(grid, data, pane, colour, look, view, last) {
    const crosshair = {
      id: "qlintCrosshair",
      afterDatasetsDraw: function (chart) {
        const at = view.cursor;
        const area = chart.chartArea;
        const x = chart.scales.x;
        const ctx = chart.ctx;
        if (at !== null && at !== undefined) {
          const px = x.getPixelForValue(at);
          if (px >= area.left && px <= area.right) {
            ctx.save();
            ctx.strokeStyle = look.foreground;
            ctx.globalAlpha = 0.6;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px, area.top);
            ctx.lineTo(px, area.bottom);
            ctx.stroke();
            ctx.restore();
          }
        }
        if (view.drag) {
          const a = x.getPixelForValue(view.drag.from);
          const b = x.getPixelForValue(view.drag.to);
          ctx.save();
          ctx.fillStyle = look.foreground;
          ctx.globalAlpha = 0.12;
          ctx.fillRect(Math.min(a, b), area.top, Math.abs(b - a), area.bottom - area.top);
          ctx.restore();
        }
      },
    };
    // A value with a null (a gap) either side has no segment, and gets a
    // point, as a line chart's does: a price set only on the rows that
    // traded drew an empty pane (#3129).
    const gap = function (p) { return !p || p.y === null; };
    const isolated = function (ctx) {
      const d = ctx.dataset.data;
      const i = ctx.dataIndex;
      return !gap(d[i]) && gap(d[i - 1]) && gap(d[i + 1]) ? 2 : 0;
    };
    return {
      type: "line",
      data: { datasets: [{ label: pane.label, column: pane.column, data: pane.data, borderColor: colour, backgroundColor: colour, pointRadius: isolated, borderWidth: 1.5, spanGaps: false }] },
      plugins: [crosshair],
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        events: [],
        scales: {
          x: Object.assign({
            type: "linear",
            ticks: Object.assign({ display: last, maxRotation: 0, callback: function (v, i, ticks) { return xText(grid, data, v, ticks && ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 0); } }, wholeX(grid, data) ? { precision: 0 } : {}),
            title: { display: last, text: data.x >= 0 ? grid.columns[0].name : "row" },
          }, view.range ? { min: view.range.min, max: view.range.max } : {}),
          y: { title: { display: true, text: pane.label } },
        },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    };
  }

  // --- SVG

  /// What an xySvg() `spec` spans: its points that have a value (`all`),
  /// its x and y ranges, the y axis' ticks, those of them in range, and
  /// the left margin their labels need (#3133).
  function xyAxes(spec) {
    const all = [];
    spec.series.forEach(function (s) { s.points.forEach(function (p) { if (p.y !== null && isFinite(p.y)) { all.push(p); } }); });
    const extent = function (pick, fixed, zero) {
      if (fixed) {
        return fixed;
      }
      let lo = Infinity;
      let hi = -Infinity;
      all.forEach(function (p) { lo = Math.min(lo, pick(p)); hi = Math.max(hi, pick(p)); });
      if (zero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      const t = C.ticks(lo, hi);
      return { lo: Math.min(lo, t.values[0]), hi: Math.max(hi, t.values[t.values.length - 1]) };
    };
    const xr = extent(function (p) { return p.x; }, spec.xRange, false);
    const yr = extent(function (p) { return p.y; }, spec.yRange, spec.series.some(function (s) { return s.area; }));
    const yt = C.ticks(yr.lo, yr.hi);
    const yValues = yt.values.filter(function (v) { return v >= yr.lo && v <= yr.hi; });
    return { all: all, xr: xr, yr: yr, yt: yt, yValues: yValues, left: C.yMargin(yValues.map(function (v) { return C.short(v, yt.step); }), Boolean(spec.yTitle)) };
  }

  /// Series of points on linear axes as an SVG document, drawn by hand as
  /// chartspec.js's chartSvg is: {series: [{label, colour, points: [{x, y,
  /// r?, colour?}], mode: "line" | "before" | "after" | "points", area}],
  /// xTitle, yTitle, xText(v, step), xWhole?, xRange?, yRange?, outline?,
  /// legend?} - `xWhole`, an x in whole units (dates), ticked by whole ones.
  /// `opts`: {width, height, background, title, at, left} - `at`, a y offset,
  /// for a pane inside another SVG, and `left`, the one margin of such panes,
  /// so that their x axes line up.
  function xySvg(spec, look, opts) {
    opts = opts || {};
    const W = opts.width || 800;
    const H = opts.height || 450;
    const xml = C.xml;
    const fg = xml(look.foreground || "#333");
    const border = xml(look.border || "#ccc");
    const right = 20;
    const top = opts.title ? 40 : 16;
    const out = ['<svg xmlns="http://www.w3.org/2000/svg"' + (opts.at !== undefined ? ' x="0" y="' + opts.at + '"' : "") + ' width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" font-family="' + xml(look.font || "sans-serif") + '" font-size="11">'];
    if (opts.background) {
      out.push('<rect width="100%" height="100%" fill="' + xml(opts.background) + '"/>');
    }
    if (opts.title) {
      out.push('<text x="' + W / 2 + '" y="22" text-anchor="middle" font-size="14" fill="' + fg + '">' + xml(opts.title) + "</text>");
    }
    const axes = xyAxes(spec);
    if (axes.all.length === 0 && !spec.outline) {
      out.push('<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" fill="' + fg + '">' + xml(spec.note || "Nothing to chart.") + "</text></svg>");
      return out.join("\n");
    }
    const xr = axes.xr;
    const yr = axes.yr;
    const yt = axes.yt;
    const left = opts.left || axes.left;
    const pw = W - left - right;
    // The legend in as many rows as it takes (#3132), a third of the image
    // at most.
    const legend = spec.legend === false ? [] : C.legendRows(spec.legendItems || spec.series.map(function (s) { return { label: s.label, colour: s.colour }; }), left, W - right, Math.max(1, Math.floor(H / 3 / 14)));
    const bottom = spec.legend === false && !spec.xTitle ? 28 : C.legendMargin(legend);
    const ph = H - top - bottom;
    // Halved, so a span past the largest double does not overflow.
    const X = function (v) { return left + (xr.hi === xr.lo ? pw / 2 : ((v / 2 - xr.lo / 2) / (xr.hi / 2 - xr.lo / 2)) * pw); };
    const Y = function (v) { return top + ph - (yr.hi === yr.lo ? ph / 2 : ((v / 2 - yr.lo / 2) / (yr.hi / 2 - yr.lo / 2)) * ph); };
    const f = function (v) { return v.toFixed(1); };
    out.push('<clipPath id="plot' + (opts.at || 0) + '"><rect x="' + left + '" y="' + top + '" width="' + pw + '" height="' + ph + '"/></clipPath>');
    axes.yValues.forEach(function (v) {
      out.push('<line x1="' + left + '" x2="' + (left + pw) + '" y1="' + f(Y(v)) + '" y2="' + f(Y(v)) + '" stroke="' + border + '" stroke-width="0.5"/>');
      out.push('<text x="' + (left - 6) + '" y="' + f(Y(v)) + '" dy="0.32em" text-anchor="end" fill="' + fg + '">' + xml(C.short(v, yt.step)) + "</text>");
    });
    const xt = C.ticks(xr.lo, xr.hi, spec.xWhole);
    out.push.apply(out, C.xLabels(xt.values.filter(function (v) { return v >= xr.lo && v <= xr.hi; }).map(function (v) {
      return { x: X(v), text: spec.xText ? spec.xText(v, xt.step) : C.short(v, xt.step) };
    }), top + ph + 16, W, fg));
    out.push('<rect x="' + left + '" y="' + top + '" width="' + pw + '" height="' + ph + '" fill="none" stroke="' + border + '"/>');
    out.push('<g clip-path="url(#plot' + (opts.at || 0) + ')">');
    if (spec.outline) {
      let d = "";
      spec.outline.RINGS.forEach(function (ring) {
        for (let i = 0; i < ring.length; i += 2) {
          d += (i === 0 ? "M" : "L") + f(X(ring[i] / spec.outline.SCALE)) + " " + f(Y(ring[i + 1] / spec.outline.SCALE));
        }
        d += "Z";
      });
      out.push('<path d="' + d + '" fill="' + xml(look.land || "rgba(128,128,128,0.18)") + '" stroke="' + border + '" stroke-width="0.6"/>');
    }
    spec.series.forEach(function (s) {
      const colour = xml(s.colour);
      if (s.mode === "points") {
        s.points.forEach(function (p) {
          const c = xml(p.colour || s.colour);
          out.push('<circle cx="' + f(X(p.x)) + '" cy="' + f(Y(p.y)) + '" r="' + f(p.r || 2.5) + '" fill="' + c + '" fill-opacity="0.75" stroke="' + c + '"/>');
        });
        return;
      }
      // Runs between nulls, each its own path.
      const runs = [];
      let run = [];
      s.points.forEach(function (p) {
        if (p.y === null || !isFinite(p.y)) {
          if (run.length) {
            runs.push(run);
          }
          run = [];
        } else {
          run.push([X(p.x), Y(p.y)]);
        }
      });
      if (run.length) {
        runs.push(run);
      }
      runs.forEach(function (pts) {
        let d = "M" + f(pts[0][0]) + " " + f(pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          d += s.mode === "before" ? " V" + f(pts[i][1]) + " H" + f(pts[i][0]) : s.mode === "after" ? " H" + f(pts[i][0]) + " V" + f(pts[i][1]) : " L" + f(pts[i][0]) + " " + f(pts[i][1]);
        }
        if (s.area) {
          const base = f(Y(0));
          out.push('<path d="' + d + " V" + base + " H" + f(pts[0][0]) + ' Z" fill="' + colour + '" fill-opacity="0.3" stroke="none"/>');
        }
        out.push('<path d="' + d + '" fill="none" stroke="' + colour + '" stroke-width="1.5"/>');
        // A value alone between nulls is a point: its path is a move (#3129).
        if (pts.length === 1) {
          out.push('<circle cx="' + f(pts[0][0]) + '" cy="' + f(pts[0][1]) + '" r="2" fill="' + colour + '"/>');
        }
      });
    });
    out.push("</g>");
    if (spec.xTitle) {
      out.push('<text x="' + (left + pw / 2) + '" y="' + (top + ph + 34) + '" text-anchor="middle" fill="' + fg + '">' + xml(spec.xTitle) + "</text>");
    }
    if (spec.yTitle) {
      out.push('<text transform="translate(14 ' + (top + ph / 2) + ') rotate(-90)" text-anchor="middle" fill="' + fg + '">' + xml(spec.yTitle) + "</text>");
    }
    out.push.apply(out, C.legendSvg(legend, H, fg));
    out.push("</svg>");
    return out.join("\n");
  }

  /// A depthData() as SVG.
  function depthSvg(data, look, opts) {
    const colour = { bid: look.up || "#89d185", ask: look.down || "#f14c4c" };
    return xySvg({
      series: data.datasets.map(function (d) { return { label: d.label, colour: colour[d.side], points: d.data, mode: d.stepped, area: true }; }),
      xTitle: "price",
      yTitle: "cumulative size",
      note: data.note,
    }, look, Object.assign({}, opts, { title: (opts && opts.title) || depthTitle(data) }));
  }

  /// A mapData() as SVG, on the world's outline.
  function mapSvg(data, look, opts, world) {
    const d = data.datasets[0];
    return xySvg({
      series: d ? [{ label: d.label, colour: look.colours[0], mode: "points", points: d.data.map(function (p, i) { return { x: p.x, y: p.y, r: p.r, colour: d.colours[i] }; }) }] : [],
      xRange: { lo: -180, hi: 180 },
      yRange: { lo: -90, hi: 90 },
      outline: world,
      xTitle: "longitude",
      yTitle: "latitude",
      legendItems: data.legend && data.legend.length ? data.legend : undefined,
      legend: Boolean(data.legend && data.legend.length),
      note: data.note,
    }, look, opts);
  }

  /// Linked panes as one SVG: each pane its own chart, stacked, over the
  /// zoom `opts.range` when given, the x labels under the last.
  function linkedSvg(grid, data, look, colours, opts) {
    opts = opts || {};
    const W = opts.width || 800;
    const n = Math.max(1, data.panes.length);
    const each = Math.max(120, Math.round((opts.height || 450) / n));
    const H = each * n + (opts.title ? 24 : 0);
    const xml = C.xml;
    const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">'];
    if (opts.background) {
      out.push('<rect width="100%" height="100%" fill="' + xml(opts.background) + '"/>');
    }
    if (opts.title) {
      out.push('<text x="' + W / 2 + '" y="18" text-anchor="middle" font-size="14" font-family="' + xml(look.font || "sans-serif") + '" fill="' + xml(look.foreground || "#333") + '">' + xml(opts.title) + "</text>");
    }
    const xRange = opts.range ? { lo: opts.range.min, hi: opts.range.max } : undefined;
    const specs = data.panes.map(function (p, k) {
      const last = k === data.panes.length - 1;
      return {
        series: [{ label: p.label, colour: colours[k % colours.length], mode: "line", points: inRange(p.data, opts.range) }],
        xRange: xRange || (function () {
          let lo = Infinity;
          let hi = -Infinity;
          data.panes.forEach(function (q) { q.data.forEach(function (pt) { lo = Math.min(lo, pt.x); hi = Math.max(hi, pt.x); }); });
          return lo <= hi ? { lo: lo, hi: hi } : undefined;
        })(),
        xText: function (v, step) { return last ? xText(grid, data, v, step) : ""; },
        xWhole: wholeX(grid, data),
        xTitle: last ? (data.x >= 0 ? grid.columns[0].name : "row") : "",
        yTitle: p.label,
        legend: false,
      };
    });
    // One margin for every pane, the widest any needs, so that a time is
    // at the same x in each (#3133).
    const left = specs.reduce(function (w, spec) { return Math.max(w, xyAxes(spec).left); }, 0);
    specs.forEach(function (spec, k) {
      out.push(xySvg(spec, look, { width: W, height: each, at: (opts.title ? 24 : 0) + k * each, left: left }));
    });
    out.push("</svg>");
    return out.join("\n");
  }

  const helpers = {
    depthColumns: depthColumns,
    depthBook: depthBook,
    depthByItself: depthByItself,
    unsidedText: unsidedText,
    depthData: depthData,
    depthTitle: depthTitle,
    depthConfig: depthConfig,
    depthSvg: depthSvg,
    mapColumns: mapColumns,
    mapData: mapData,
    mapConfig: mapConfig,
    mapSvg: mapSvg,
    blend: blend,
    linkedData: linkedData,
    nearestIndex: nearestIndex,
    readout: readout,
    zoomRange: zoomRange,
    inRange: inRange,
    zoomOver: zoomOver,
    xText: xText,
    linkedConfig: linkedConfig,
    linkedSvg: linkedSvg,
    xySvg: xySvg,
  };
  if (node) {
    module.exports = helpers;
  } else {
    root.qlintChartMore = helpers;
  }
})(typeof self !== "undefined" ? self : this);
