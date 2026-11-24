//! qSQL to functional form and back: `select n:count i by sym from t where
//! px>2` and `?[t;enlist(>;`px;2);(enlist`sym)!enlist`sym;(enlist`n)!enlist(count;`i)]`
//! are the same query, and either can be rewritten as the other where the
//! text settles every part.
//!
//! Neither direction runs anything. An expression is read the way q reads
//! one - right to left, a dyad taking everything to its right, a noun next
//! to a noun an application - into the parse tree `parse` gives for it, and
//! a tree is written back as the text that reads to it. A name in a query
//! becomes a symbol (`` `px ``), as in `parse`: whether it is a column or a
//! global is the query's to settle when it runs, and the functional form
//! settles it the same way. A symbol literal is enlisted, the one thing a
//! hand-written functional form most often gets wrong. A query in
//! parentheses inside another is a tree of its own there (`Node::Query`),
//! and is read back as one.
//!
//! What this cannot read it refuses, with the reason, rather than guess: an
//! adverb (`f'`, `,/`), an assignment inside an expression, a projection
//! (`f[x;]`), `select[n]`, a glyph used as a monad (q refuses `-px` too:
//! `neg px` is the monad), and
//! anything else the small reader below does not know. A select column with
//! no name is named the way q names it - from the first name its tree reads
//! from, `x` where that is a literal (see `derived`), refused where this is
//! not sure of it - and duplicates get `1`, `2`, ... after them; `tests/functional.rs` holds the
//! cases, each compared with `~` against the qSQL it came from in KDB-X.
//! PeachQ refuses one shape KDB-X runs: a where clause that is a bare name
//! (`where flag`, `enlist`flag`).
//!
//! A functional form says more than qSQL can: where one has no qSQL - a
//! column named with a word of q's own (`column`) - it is refused too. And
//! `enlist x` in a tree is not the call `(enlist;x)`: over anything but one
//! atom it is q's quote, read back as the constant under it (`constant`).
use super::layout;

/// A rewrite of the query at the cursor: the bytes `start..end` replaced by
/// `text`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Conversion {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// A parse tree, as `parse` would give it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Node {
    /// A literal written as is: a number or a vector of them, a boolean, a
    /// string, a temporal, a lambda, `()`.
    Leaf(String),
    /// A name: a column or a global, a symbol in the tree.
    Name(String),
    /// A symbol literal, one or several, enlisted in the tree.
    Sym(Vec<String>),
    /// A primitive or a keyword in function position: `>`, `count`, `in`.
    Verb(String),
    /// A function applied to its arguments: `(f;x;y)`.
    Apply(Box<Node>, Vec<Node>),
    /// A general list, `(a;b)`: `(enlist;a;b)` in the tree.
    List(Vec<Node>),
    /// A query inside the expression, in both spellings: the tree `parse`
    /// gives for it, `(?;`t;();();enlist `c)`, and its qSQL in parentheses.
    Query { tree: String, qsql: String },
}

/// The keywords q applies infix, beyond the ones the catalogue writes as
/// `x kw y`: the `.q` functions of two arguments.
const MORE_INFIX: [&str; 18] = [
    "fby", "each", "peach", "over", "scan", "prior", "xasc", "xdesc", "xgroup", "xkey", "lj",
    "ljf", "ij", "ijf", "uj", "ujf", "pj", "asof",
];

fn infix(word: &str) -> bool {
    MORE_INFIX.contains(&word)
        || crate::builtin(word).is_some_and(|b| {
            b.syntax
                .strip_prefix("x ")
                .and_then(|s| s.strip_prefix(word))
                .is_some_and(|s| s.starts_with(" y"))
        })
}

/// Whether `word` is one of q's own, so a function rather than a name.
fn keyword(word: &str) -> bool {
    crate::is_reserved(word) || MORE_INFIX.contains(&word)
}

#[derive(Clone, PartialEq, Debug)]
enum Tok {
    Leaf(String),
    Sym(Vec<String>),
    Name(String),
    /// A query inside the expression: its tree and its qSQL (`Node::Query`).
    Query(String, String),
    Op(String),
    Open(u8),
    Close(u8),
    Semi,
}

const GLYPHS: &[u8] = b"=<>+-*%&|,^#_~$!?@.";

/// `text` as tokens, or why it cannot be read here.
fn tokens(text: &str) -> Result<Vec<Tok>, String> {
    let b = text.as_bytes();
    let mut out: Vec<Tok> = vec![];
    let mut i = 0;
    // Whether the token before ends a noun, so a `-` next to it, with no
    // blank between, is the dyad rather than a sign.
    let noun_end = |out: &Vec<Tok>, i: usize| {
        i > 0
            && !b[i - 1].is_ascii_whitespace()
            && matches!(
                out.last(),
                Some(Tok::Leaf(_) | Tok::Sym(_) | Tok::Name(_) | Tok::Query(..) | Tok::Close(_))
            )
    };
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let number_start = c.is_ascii_digit()
            || (c == b'.' && next.is_some_and(|n| n.is_ascii_digit()))
            || (c == b'-'
                && (next.is_some_and(|n| n.is_ascii_digit())
                    || (next == Some(b'.') && b.get(i + 2).is_some_and(|n| n.is_ascii_digit())))
                && !noun_end(&out, i));
        if number_start {
            let start = i;
            i += 1;
            // A sign straight after a lower-case `e` is the exponent's, as
            // q's tokenizer reads it (`-4!` on KDB-X 5): `1e-3` and `1e+1`
            // are one number each. A `-` there always is (`1e-` too), a
            // `+` only before a digit (`1e+x` is `1e`, `+`, `x`), and
            // `1E-3` is three tokens.
            while i < b.len()
                && (b[i].is_ascii_alphanumeric()
                    || b[i] == b'.'
                    || b[i] == b':'
                    || (b[i - 1] == b'e'
                        && (b[i] == b'-'
                            || (b[i] == b'+' && b.get(i + 1).is_some_and(u8::is_ascii_digit)))))
            {
                i += 1;
            }
            let atom = text[start..i].to_string();
            // A vector: numbers separated by blanks are one literal.
            match out.last_mut() {
                Some(Tok::Leaf(prev))
                    if start > 0
                        && b[start - 1] == b' '
                        && prev
                            .bytes()
                            .next()
                            .is_some_and(|f| f.is_ascii_digit() || f == b'-' || f == b'.') =>
                {
                    prev.push(' ');
                    prev.push_str(&atom);
                }
                _ => out.push(Tok::Leaf(atom)),
            }
            continue;
        }
        match c {
            b'`' => {
                let mut syms = vec![];
                while i < b.len() && b[i] == b'`' {
                    let start = i + 1;
                    i += 1;
                    while i < b.len()
                        && (b[i].is_ascii_alphanumeric()
                            || matches!(b[i], b'_' | b'.' | b':' | b'/'))
                    {
                        i += 1;
                    }
                    syms.push(text[start..i].to_string());
                }
                out.push(Tok::Sym(syms));
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                if i >= b.len() {
                    return Err("an unterminated string".into());
                }
                i += 1;
                out.push(Tok::Leaf(text[start..i].to_string()));
            }
            b'{' => {
                let start = i;
                let mut depth = 0i32;
                let mut string = false;
                while i < b.len() {
                    match b[i] {
                        b'\\' if string => i += 1,
                        b'"' => string = !string,
                        b'{' if !string => depth += 1,
                        b'}' if !string => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                if i >= b.len() {
                    return Err("an unclosed lambda".into());
                }
                i += 1;
                out.push(Tok::Leaf(text[start..i].to_string()));
            }
            b'(' | b'[' => {
                out.push(Tok::Open(c));
                i += 1;
            }
            b')' | b']' => {
                out.push(Tok::Close(c));
                i += 1;
            }
            b';' => {
                out.push(Tok::Semi);
                i += 1;
            }
            b'\'' | b'/' | b'\\' => return Err("an adverb".into()),
            b':' => return Err("an assignment inside an expression".into()),
            _ if c.is_ascii_alphabetic()
                || (c == b'.' && next.is_some_and(|n| n.is_ascii_alphabetic())) =>
            {
                let start = i;
                i += 1;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.')
                {
                    i += 1;
                }
                // A query word is no function applied to what follows:
                // it opens a query of its own, read as one.
                if layout::LEADS.contains(&&text[start..i]) {
                    let (tree, end) = nested(text, start)?;
                    out.push(Tok::Query(tree, format!("({})", &text[start..end])));
                    i = end;
                    continue;
                }
                out.push(Tok::Name(text[start..i].to_string()));
            }
            _ if GLYPHS.contains(&c) => {
                let two = matches!((c, next), (b'<', Some(b'=' | b'>')) | (b'>', Some(b'=')));
                let n = if two { 2 } else { 1 };
                if matches!(b.get(i + n), Some(b'\'' | b'/' | b'\\' | b':')) {
                    return Err("an adverb or an assignment".into());
                }
                out.push(Tok::Op(text[i..i + n].to_string()));
                i += n;
            }
            _ => return Err(format!("`{}`", c as char)),
        }
    }
    Ok(out)
}

/// A reader of an expression's tokens into its tree.
struct Reader {
    toks: Vec<Tok>,
    at: usize,
}

impl Reader {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.at)
    }

    fn ends(&self) -> bool {
        matches!(self.peek(), None | Some(Tok::Close(_) | Tok::Semi))
    }

    /// An expression: a term, then a dyad and everything to its right, or a
    /// noun applied to everything to its right.
    fn expr(&mut self) -> Result<Node, String> {
        let left = self.term()?;
        if self.ends() {
            return Ok(left);
        }
        match self.peek().cloned() {
            Some(Tok::Op(op)) => {
                if matches!(left, Node::Verb(_)) {
                    return Err(format!("`{op}` after a function"));
                }
                self.at += 1;
                if self.ends() {
                    return Err(format!("`{op}` with nothing on its right"));
                }
                let right = self.expr()?;
                Ok(Node::Apply(Box::new(Node::Verb(op)), vec![left, right]))
            }
            Some(Tok::Name(word)) if infix(&word) => {
                self.at += 1;
                if self.ends() {
                    return Err(format!("`{word}` with nothing on its right"));
                }
                let right = self.expr()?;
                Ok(Node::Apply(Box::new(Node::Verb(word)), vec![left, right]))
            }
            _ => {
                let right = self.expr()?;
                Ok(Node::Apply(Box::new(left), vec![right]))
            }
        }
    }

    /// A noun or a function, with any bracketed arguments after it.
    fn term(&mut self) -> Result<Node, String> {
        let tok = self.peek().cloned().ok_or("an empty expression")?;
        self.at += 1;
        let mut node = match tok {
            Tok::Leaf(t) => Node::Leaf(t),
            Tok::Sym(s) => Node::Sym(s),
            Tok::Name(n) if keyword(&n) => Node::Verb(n),
            Tok::Name(n) => Node::Name(n),
            Tok::Query(tree, qsql) => Node::Query { tree, qsql },
            Tok::Op(op) if matches!(self.peek(), Some(Tok::Open(b'['))) => Node::Verb(op),
            Tok::Op(op) => return Err(format!("`{op}` used as a monad")),
            Tok::Open(b'(') => {
                let items = self.items(b')')?;
                match items.len() {
                    0 => Node::Leaf("()".into()),
                    1 => items.into_iter().next().unwrap_or(Node::Leaf("()".into())),
                    _ => Node::List(items),
                }
            }
            Tok::Open(_) => return Err("a bracket with nothing before it".into()),
            Tok::Close(_) | Tok::Semi => return Err("an unbalanced bracket".into()),
        };
        while matches!(self.peek(), Some(Tok::Open(b'['))) {
            self.at += 1;
            let args = self.items(b']')?;
            if args.is_empty() {
                return Err("a call with no arguments".into());
            }
            node = Node::Apply(Box::new(node), args);
        }
        Ok(node)
    }

    /// The items up to the closing `close`, split at `;`.
    fn items(&mut self, close: u8) -> Result<Vec<Node>, String> {
        let mut items = vec![];
        if self.peek() == Some(&Tok::Close(close)) {
            self.at += 1;
            return Ok(items);
        }
        loop {
            if matches!(self.peek(), Some(Tok::Semi | Tok::Close(_))) {
                return Err("an empty argument (a projection)".into());
            }
            items.push(self.expr()?);
            match self.peek() {
                Some(Tok::Semi) => self.at += 1,
                Some(Tok::Close(c)) if *c == close => {
                    self.at += 1;
                    return Ok(items);
                }
                _ => return Err("an unbalanced bracket".into()),
            }
        }
    }
}

/// The tree of the expression `text`.
pub(crate) fn tree(text: &str) -> Result<Node, String> {
    let toks = tokens(text)?;
    if toks.is_empty() {
        return Err("an empty expression".into());
    }
    let mut r = Reader { toks, at: 0 };
    let node = r.expr()?;
    if r.at != r.toks.len() {
        return Err("an unbalanced bracket".into());
    }
    Ok(node)
}

/// A tree written as functional-form text.
pub(crate) fn functional(node: &Node) -> String {
    match node {
        Node::Leaf(t) => t.clone(),
        Node::Name(n) => format!("`{n}"),
        Node::Sym(s) => format!("enlist{}", symbols(s)),
        Node::Verb(v) => v.clone(),
        Node::Apply(f, args) => {
            let mut parts = vec![functional(f)];
            parts.extend(args.iter().map(functional));
            format!("({})", parts.join(";"))
        }
        Node::List(items) => {
            let mut parts = vec!["enlist".to_string()];
            parts.extend(items.iter().map(functional));
            format!("({})", parts.join(";"))
        }
        Node::Query { tree, .. } => tree.clone(),
    }
}

fn symbols(s: &[String]) -> String {
    s.iter().map(|s| format!("`{s}")).collect()
}

/// The name q gives a select column that has none, as far as this is sure
/// of it. q takes it from one argument of the tree, all the way down: the
/// only one of a monad; the first of `+ - * % | &`, `and` and `or`; the last
/// of `= ^ #`, of the other keywords (`2 xbar size` is `size`, `size mod 3`
/// is `x`) and of a general list. A literal, and the virtual `i`, give `x`.
/// Other glyphs and a bracketed call of several arguments are not known
/// here. Checked in KDB-X; PeachQ takes a list's first item instead.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Derived {
    Name(String),
    X,
    Unknown,
}

pub(crate) fn derived(node: &Node) -> Derived {
    match node {
        Node::Name(n) if n == "i" => Derived::X,
        // A dotted name gives its last part: `select e.month from e` is
        // `month` on KDB-X, as `.ns.v` is `v` (#1300).
        Node::Name(n) => Derived::Name(n.rsplit('.').next().unwrap_or(n).to_string()),
        Node::Leaf(_) | Node::Sym(_) => Derived::X,
        Node::Verb(_) | Node::Query { .. } => Derived::Unknown,
        Node::List(items) => items.last().map_or(Derived::X, derived),
        Node::Apply(_, args) if args.len() == 1 => derived(&args[0]),
        Node::Apply(f, args) if args.len() == 2 => match &**f {
            Node::Verb(v) if ["+", "-", "*", "%", "|", "&", "and", "or"].contains(&v.as_str()) => {
                derived(&args[0])
            }
            Node::Verb(v) if ["=", "^", "#"].contains(&v.as_str()) => derived(&args[1]),
            Node::Verb(v) if v.bytes().all(|c| c.is_ascii_alphanumeric()) => derived(&args[1]),
            _ => Derived::Unknown,
        },
        Node::Apply(..) => Derived::Unknown,
    }
}

/// An item of a select or by list: its name, where it is written `n:e`,
/// and its expression.
fn named(item: &str) -> (Option<String>, &str) {
    let b = item.as_bytes();
    let mut i = 0;
    if b.first().is_some_and(|c| c.is_ascii_alphabetic()) {
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
        }
        let mut j = i;
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        if b.get(j) == Some(&b':') && !matches!(b.get(j + 1), Some(b':' | b'/' | b'\\' | b'\'')) {
            return (Some(item[..i].to_string()), item[j + 1..].trim());
        }
    }
    (None, item)
}

/// The name q gives the next column of a list whose columns so far were
/// written with (or implied) the names `bases`, when this one's is `base`:
/// `base` itself the first time, then `base` and the number of times it
/// came before, whether written or implied - and whatever the other names
/// are. On KDB-X, `select a:px, a:size, a1:sym from t` has the columns
/// `` `a`a1`a1 ``, and `select px, px, px1, px from t` `` `px`px1`px1`px2 ``.
fn q_name(bases: &[String], base: &str) -> String {
    match bases.iter().filter(|b| *b == base).count() {
        0 => base.to_string(),
        n => format!("{base}{n}"),
    }
}

/// The columns of a select, by or update list: each one's name and tree,
/// named as q names them.
fn columns(items: &[String]) -> Result<Vec<(String, Node)>, String> {
    let mut out: Vec<(String, Node)> = vec![];
    let mut bases: Vec<String> = vec![];
    for item in items {
        let (name, expr) = named(item);
        let node = tree(expr)?;
        // A name written repeats as one implied does (#2062).
        let base = match name {
            Some(name) => name,
            None => match derived(&node) {
                Derived::Name(n) => n,
                Derived::X => "x".into(),
                Derived::Unknown => {
                    return Err(format!(
                        "a column with no name whose name q would choose is not certain here: write it `name:{expr}`"
                    ));
                }
            },
        };
        out.push((q_name(&bases, &base), node));
        bases.push(base);
    }
    Ok(out)
}

/// A dictionary of names to trees, as functional-form text.
fn dict(cols: &[(String, Node)]) -> String {
    match cols {
        [(name, node)] => format!("(enlist`{name})!enlist {}", functional(node)),
        _ => {
            let keys: String = cols.iter().map(|(n, _)| format!("`{n}")).collect();
            let vals: Vec<String> = cols.iter().map(|(_, v)| functional(v)).collect();
            format!("{keys}!({})", vals.join(";"))
        }
    }
}

/// The where list, as functional-form text.
fn constraints(items: &[String]) -> Result<String, String> {
    let trees = items
        .iter()
        .map(|i| tree(i))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(match &trees[..] {
        [] => "()".into(),
        [one] => format!("enlist {}", functional(one)),
        many => format!(
            "({})",
            many.iter().map(functional).collect::<Vec<_>>().join(";")
        ),
    })
}

/// The query around byte `at` in its functional form; `None` outside a
/// query, and the reason where one cannot be rewritten.
pub(crate) fn to_functional_at(
    code: &str,
    comments: &str,
    source: &str,
    at: usize,
) -> Option<Result<Conversion, String>> {
    let parts = layout::parts_at(code, comments, source, at)?;
    let text = to_functional(&parts);
    Some(text.map(|text| Conversion {
        start: parts.start,
        end: parts.end,
        text,
    }))
}

fn to_functional(p: &layout::Parts) -> Result<String, String> {
    let f = form(p)?;
    let [c, b, a] = &f.rest;
    Ok(format!("{}[{};{};{};{}]", f.verb, f.table, c.0, b.0, a.0))
}

/// The query whose lead word is at byte `at` of the expression `text`, as
/// the tree `parse` holds for a query inside another, and where it ends.
/// The tree's arguments are the functional form's, each as `eval` must find
/// it to give that argument: the table an expression's tree, and the others
/// enlisted unless `eval` leaves them as they are. On KDB-X,
/// `parse "select from t where a in (exec b from u where c>1)"` holds
/// ``(?;`u;,,(>;`c;1);();,`b)``.
fn nested(text: &str, at: usize) -> Result<(String, usize), String> {
    let v = crate::views(text);
    let p = layout::parts_at(&v.code, &v.comments, text, at)
        .filter(|p| p.start == at)
        .ok_or("a query inside the query whose parts are not certain here")?;
    let f = form(&p)?;
    let quoted = |(text, constant): &(String, bool)| {
        if *constant {
            text.clone()
        } else {
            format!("enlist {text}")
        }
    };
    let [c, b, a] = &f.rest;
    let table = functional(&tree(&f.from)?);
    Ok((
        format!(
            "({};{table};{};{};{})",
            f.verb,
            quoted(c),
            quoted(b),
            quoted(a)
        ),
        p.end,
    ))
}

/// A query as its functional form's parts: the verb, the table as the form
/// writes it and as the query does, and the where, by and column arguments,
/// each with whether `eval` leaves it as it is (`()`, a boolean, a
/// dictionary, an empty symbol list), so that a tree holds it unchanged.
struct Form {
    verb: char,
    table: String,
    from: String,
    rest: [(String, bool); 3],
}

fn form(p: &layout::Parts) -> Result<Form, String> {
    let clause = |w: &str| p.clauses.iter().find(|(c, _)| *c == w).map(|(_, i)| i);
    let from = clause("from")
        .and_then(|i| i.first())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("a query with no table")?;
    let wheres = clause("where").cloned().unwrap_or_default();
    let by = clause("by").cloned().unwrap_or_default();
    let mut head = p.head.clone();
    if head.first().is_some_and(|h| h.starts_with('[')) {
        return Err(format!(
            "`{}[...]`, whose functional form takes more arguments",
            p.lead
        ));
    }
    let mut distinct = false;
    if p.lead == "select"
        && let Some(first) = head.first_mut()
        && let Some(rest) = first.strip_prefix("distinct")
        && (rest.is_empty() || rest.starts_with(' '))
    {
        distinct = true;
        *first = rest.trim().to_string();
        if first.is_empty() {
            head.remove(0);
        }
    }
    let c = constraints(&wheres)?;
    let table = if from.contains([' ', '[', '(']) && !from.starts_with('(') {
        format!("({from})")
    } else {
        from.to_string()
    };
    let c = (c.clone(), c == "()");
    let made = |verb: char, b: (String, bool), a: (String, bool)| Form {
        verb,
        table: table.clone(),
        from: from.to_string(),
        rest: [c.clone(), b, a],
    };
    let constant = |text: String| (text, true);
    let evaluated = |text: String| (text, false);
    match p.lead {
        "select" | "update" => {
            if distinct && !by.is_empty() {
                return Err("`select distinct` with a by clause".into());
            }
            let cols = columns(&head)?;
            if p.lead == "update" && cols.is_empty() {
                return Err("an update with no columns".into());
            }
            let b = if distinct {
                "1b".to_string()
            } else if by.is_empty() {
                "0b".to_string()
            } else {
                dict(&columns(&by)?)
            };
            let a = if cols.is_empty() {
                "()".to_string()
            } else {
                dict(&cols)
            };
            let verb = if p.lead == "select" { '?' } else { '!' };
            Ok(made(verb, constant(b), constant(a)))
        }
        "exec" => {
            let b = match &by[..] {
                [] => constant("()".to_string()),
                [one] if named(one).0.is_none() => evaluated(match tree(one)? {
                    Node::Name(n) => format!("`{n}"),
                    other => functional(&other),
                }),
                _ => constant(dict(&columns(&by)?)),
            };
            let a = match &head[..] {
                [] => return Err("an exec with no columns".into()),
                [one] if named(one).0.is_none() => evaluated(functional(&tree(one)?)),
                _ => constant(dict(&columns(&head)?)),
            };
            Ok(made('?', b, a))
        }
        "delete" => {
            if !by.is_empty() {
                return Err("a delete with a by clause".into());
            }
            match (&head[..], wheres.is_empty()) {
                ([], true) => Err("a delete with neither columns nor a where clause".into()),
                ([], false) => Ok(made(
                    '!',
                    constant("0b".into()),
                    constant("`symbol$()".into()),
                )),
                (cols, true) => {
                    let mut names = String::new();
                    for col in cols {
                        match tree(col)? {
                            Node::Name(n) => names.push_str(&format!("`{n}")),
                            _ => return Err("a delete of something other than column names".into()),
                        }
                    }
                    // One column is `enlist`a`: q refuses `` `a `` alone ('type).
                    if cols.len() == 1 {
                        names.insert_str(0, "enlist");
                    }
                    Ok(made('!', constant("0b".into()), evaluated(names)))
                }
                (_, false) => Err("a delete with both columns and a where clause".into()),
            }
        }
        _ => Err("an unknown query".into()),
    }
}

// The other direction: functional-form text read back into trees.

/// A value as a functional form writes it.
#[derive(Clone, PartialEq, Debug)]
enum Data {
    /// `(a;b;c)`; `()` is an empty one.
    List(Vec<Data>),
    /// `enlist x` or `,x`.
    Enlist(Box<Data>),
    /// `k!v`.
    Dict(Box<Data>, Box<Data>),
    Sym(Vec<String>),
    Leaf(String),
    /// A name: `count`, `enlist`, a glyph, a global.
    Word(String),
    /// `` `symbol$() ``, the empty column list of a row delete.
    NoSymbols,
}

struct DataReader {
    toks: Vec<Tok>,
    at: usize,
}

impl DataReader {
    fn value(&mut self) -> Result<Data, String> {
        let left = self.primary()?;
        if matches!(self.toks.get(self.at), Some(Tok::Op(o)) if o == "!") {
            self.at += 1;
            let right = self.value()?;
            return Ok(Data::Dict(Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn primary(&mut self) -> Result<Data, String> {
        let tok = self.toks.get(self.at).cloned().ok_or("an empty argument")?;
        self.at += 1;
        Ok(match tok {
            Tok::Name(n) if n == "enlist" && !self.at_end() => {
                Data::Enlist(Box::new(self.value()?))
            }
            Tok::Op(o) if o == "," && !self.at_end() => Data::Enlist(Box::new(self.value()?)),
            Tok::Sym(s)
                if s == ["symbol"]
                    && self.toks.get(self.at) == Some(&Tok::Op("$".into()))
                    && self.toks.get(self.at + 1) == Some(&Tok::Open(b'('))
                    && self.toks.get(self.at + 2) == Some(&Tok::Close(b')')) =>
            {
                self.at += 3;
                Data::NoSymbols
            }
            Tok::Sym(s) => Data::Sym(s),
            Tok::Leaf(l) => Data::Leaf(l),
            Tok::Name(n) => Data::Word(n),
            Tok::Op(o) => Data::Word(o),
            Tok::Open(b'(') => {
                let mut items = vec![];
                if self.toks.get(self.at) == Some(&Tok::Close(b')')) {
                    self.at += 1;
                    return Ok(Data::List(items));
                }
                loop {
                    items.push(self.value()?);
                    match self.toks.get(self.at) {
                        Some(Tok::Semi) => self.at += 1,
                        Some(Tok::Close(b')')) => {
                            self.at += 1;
                            break;
                        }
                        _ => return Err("an unbalanced bracket".into()),
                    }
                }
                // A parenthesised value is that value.
                if items.len() == 1 {
                    return Ok(items.remove(0));
                }
                Data::List(items)
            }
            _ => return Err("something a functional form does not hold".into()),
        })
    }

    fn at_end(&self) -> bool {
        matches!(
            self.toks.get(self.at),
            None | Some(Tok::Semi | Tok::Close(_))
        )
    }
}

/// Functional-form text as data. Glyphs alone in a list (`(>;...)`) are
/// tokens the expression reader refuses, so they are read here.
fn data(text: &str) -> Result<Data, String> {
    let toks = data_tokens(text)?;
    let mut r = DataReader { toks, at: 0 };
    let d = r.value()?;
    if r.at != r.toks.len() {
        return Err("more than one value in an argument".into());
    }
    Ok(d)
}

/// Tokens of functional-form text: as `tokens`, but a glyph followed by
/// `:` (`-:`, the monad) is one glyph, and `0b` stays a literal.
fn data_tokens(text: &str) -> Result<Vec<Tok>, String> {
    // The glyph-colon monads `parse` writes, renamed to their keywords so
    // the reader below needs no second spelling.
    let mut t = text.to_string();
    for (from, to) in [
        ("-:", "neg"),
        ("#:", "count"),
        ("~:", "not"),
        ("^:", "null"),
    ] {
        t = t.replace(from, to);
    }
    tokens(&t)
}

/// `name` as a column qSQL can name. A functional form names one with any
/// symbol; qSQL reads a word of q's own as that word wherever it stands -
/// `select count:px from t` is 'assign, and `where count>1` compares the
/// function - and a symbol that is no name has no spelling there (#2023).
fn column(name: &str) -> Result<String, String> {
    if keyword(name) {
        return Err(format!(
            "a column named `{name}`, which qSQL reads as q's own `{name}`"
        ));
    }
    let b = name.as_bytes();
    let spelt = b
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'.')
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.'));
    if !spelt {
        return Err(format!("a column named `{name}`, which qSQL cannot spell"));
    }
    Ok(name.to_string())
}

/// A tree from functional-form data.
fn node(d: &Data) -> Result<Node, String> {
    Ok(match d {
        Data::Sym(s) if s.len() == 1 => Node::Name(column(&s[0])?),
        Data::Sym(_) => return Err("a symbol vector where a tree was expected".into()),
        Data::Enlist(inner) => match &**inner {
            Data::Sym(s) => Node::Sym(s.clone()),
            // One atom enlisted is a vector of one item, which `eval`
            // leaves as it is: `enlist 7` in qSQL too.
            Data::Leaf(l) if atom(l) => Node::List(vec![Node::Leaf(l.clone())]),
            // Anything else enlisted is a general list of one item, q's
            // quote: `eval` gives the item back as it stands (#2024).
            other => constant(other)?,
        },
        Data::Leaf(l) => Node::Leaf(l.clone()),
        Data::Word(w) => Node::Verb(w.clone()),
        Data::List(items) if items.is_empty() => Node::Leaf("()".into()),
        Data::List(items) => match &items[0] {
            Data::Word(w) if w == "enlist" => {
                Node::List(items[1..].iter().map(node).collect::<Result<_, _>>()?)
            }
            // A query's tree, as `parse` holds one inside another: read
            // back through its qSQL, so both spellings are in the node.
            Data::Word(w) if (w == "?" || w == "!") && items.len() == 5 => {
                let table = node(&items[1])?;
                let text = infix_text(&table)?;
                let table = match table {
                    Node::Apply(..) | Node::List(_) => format!("({text})"),
                    _ => text,
                };
                // What `eval` makes of an argument is what the form takes.
                let evaluated = |d: &Data| match d {
                    Data::Enlist(inner) => Ok((**inner).clone()),
                    Data::List(items) if items.is_empty() => Ok(d.clone()),
                    Data::Leaf(_) | Data::Dict(..) | Data::NoSymbols => Ok(d.clone()),
                    _ => {
                        Err("a query inside a tree whose arguments are not as `parse` writes them")
                    }
                };
                let qsql = written(
                    w.as_bytes()[0],
                    &table,
                    &evaluated(&items[2])?,
                    &evaluated(&items[3])?,
                    &evaluated(&items[4])?,
                )?;
                tree(&format!("({qsql})"))?
            }
            f => {
                let f = match f {
                    Data::Word(w) => Node::Verb(w.clone()),
                    Data::Sym(s) if s.len() == 1 => Node::Name(s[0].clone()),
                    Data::Leaf(l) if l.starts_with('{') => Node::Leaf(l.clone()),
                    Data::List(_) => node(f)?,
                    _ => return Err("a list whose first item is no function".into()),
                };
                let args = items[1..].iter().map(node).collect::<Result<Vec<_>, _>>()?;
                if args.is_empty() {
                    return Err("a function with no arguments".into());
                }
                Node::Apply(Box::new(f), args)
            }
        },
        Data::Dict(..) | Data::NoSymbols => return Err("a dictionary inside a tree".into()),
    })
}

/// Whether the literal `leaf` is one atom, so that enlisting it makes a
/// vector: `7`, `0b`, `"a"`, `0x01`, `09:30:00`. A vector of several
/// (`1 2 3`, `101b`, `0x0102`, `"abc"`, `""`) and a lambda are not: a list
/// holding one of those is a general list.
fn atom(leaf: &str) -> bool {
    let b = leaf.as_bytes();
    if let Some(body) = leaf.strip_prefix('"') {
        // The characters of a string: an escape is one, `\123` too.
        let body = body.strip_suffix('"').unwrap_or(body).as_bytes();
        let (mut i, mut chars) = (0, 0);
        while i < body.len() {
            i += match body[i] {
                b'\\' if body.get(i + 1).is_some_and(u8::is_ascii_digit) => 4,
                b'\\' => 2,
                _ => 1,
            };
            chars += 1;
        }
        return chars == 1;
    }
    if leaf.starts_with('{') || leaf == "()" || leaf.contains(' ') {
        return false;
    }
    if let Some(bits) = leaf.strip_suffix('b')
        && bits.bytes().all(|c| c == b'0' || c == b'1')
    {
        return bits.len() == 1;
    }
    if leaf.starts_with("0x") {
        return (3..=4).contains(&b.len());
    }
    true
}

/// Data a tree holds unevaluated - what is under q's quote - as the
/// expression that builds it: each item of a list a constant in turn, and
/// an `enlist` inside it a list of one item.
fn constant(d: &Data) -> Result<Node, String> {
    Ok(match d {
        Data::Leaf(l) => Node::Leaf(l.clone()),
        Data::Sym(s) => Node::Sym(s.clone()),
        Data::Word(w) => Node::Verb(w.clone()),
        Data::Enlist(inner) => Node::List(vec![constant(inner)?]),
        Data::List(items) if items.is_empty() => Node::Leaf("()".into()),
        Data::List(items) => Node::List(items.iter().map(constant).collect::<Result<_, _>>()?),
        Data::Dict(..) | Data::NoSymbols => {
            return Err("a dictionary held as a constant, which no expression here writes".into());
        }
    })
}

/// A tree written as the q expression that reads to it.
pub(crate) fn infix_text(n: &Node) -> Result<String, String> {
    Ok(match n {
        Node::Leaf(t) => t.clone(),
        Node::Name(n) => n.clone(),
        Node::Sym(s) => symbols(s),
        Node::Verb(v) => v.clone(),
        Node::Query { qsql, .. } => qsql.clone(),
        // `(enlist;x)` is a one-item list, which `(x)` is not.
        Node::List(items) if items.len() == 1 => format!("enlist {}", infix_text(&items[0])?),
        Node::List(items) => format!(
            "({})",
            items
                .iter()
                .map(infix_text)
                .collect::<Result<Vec<_>, _>>()?
                .join(";")
        ),
        Node::Apply(f, args) => {
            let left = |x: &Node| -> Result<String, String> {
                let t = infix_text(x)?;
                let wrap = match x {
                    Node::Apply(..) => true,
                    Node::List(items) => items.len() == 1,
                    _ => false,
                };
                Ok(if wrap { format!("({t})") } else { t })
            };
            match (&**f, &args[..]) {
                (Node::Verb(v), [x, y]) if v.bytes().all(|c| GLYPHS.contains(&c)) => {
                    let (x, y) = (left(x)?, infix_text(y)?);
                    // Some glyphs join what is on either side into one
                    // token: q reads `px_1` and `f.s2` as names, `1.2` as
                    // a float, and `1e-1` and `1e+1` as one number where
                    // the tree holds the real `1e` (`-4!` on KDB-X 5). So
                    // `_` and `.` always stand apart, and so does a sign
                    // after a number ending in `e` (#2060).
                    let number_e = x.ends_with('e')
                        && x.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.');
                    if v == "_" || v == "." || (number_e && (v == "-" || v == "+")) {
                        format!("{x} {v} {y}")
                    } else {
                        format!("{x}{v}{y}")
                    }
                }
                (Node::Verb(v), [x, y]) if infix(v) => {
                    format!("{} {v} {}", left(x)?, infix_text(y)?)
                }
                (Node::Verb(v), [_]) if v.bytes().all(|c| GLYPHS.contains(&c)) => {
                    return Err(format!("`{v}` applied as a monad"));
                }
                (Node::Verb(_) | Node::Name(_) | Node::Leaf(_) | Node::Query { .. }, [x]) => {
                    format!("{} {}", infix_text(f)?, infix_text(x)?)
                }
                (Node::Verb(_) | Node::Name(_) | Node::Leaf(_) | Node::Query { .. }, many) => {
                    format!(
                        "{}[{}]",
                        infix_text(f)?,
                        many.iter()
                            .map(infix_text)
                            .collect::<Result<Vec<_>, _>>()?
                            .join(";")
                    )
                }
                _ => return Err("a function that is itself an application".into()),
            }
        }
    })
}

/// `text` as one item of a qSQL list: in parentheses where a `,` outside
/// any bracket or string would split it into two.
fn one_item(text: String) -> String {
    let (mut depth, mut string, mut escape) = (0i32, false, false);
    for c in text.bytes() {
        match c {
            _ if escape => escape = false,
            b'\\' if string => escape = true,
            b'"' => string = !string,
            b'(' | b'[' | b'{' if !string => depth += 1,
            b')' | b']' | b'}' if !string => depth -= 1,
            b',' if !string && depth == 0 => return format!("({text})"),
            _ => {}
        }
    }
    text
}

/// The trees a functional form's where argument lists.
fn where_list(d: &Data) -> Result<Vec<Node>, String> {
    match d {
        Data::List(items) if items.is_empty() => Ok(vec![]),
        Data::Enlist(one) => Ok(vec![node(one)?]),
        Data::List(items) => items.iter().map(node).collect(),
        _ => Err("a where argument that is not a list of constraints".into()),
    }
}

/// The names and trees of a functional form's dictionary argument.
fn dict_items(d: &Data) -> Result<Vec<(String, Node)>, String> {
    let Data::Dict(k, v) = d else {
        return Err("a column argument that is not a dictionary".into());
    };
    let keys = match &**k {
        Data::Sym(s) if s.len() > 1 => s.clone(),
        Data::Enlist(one) => match &**one {
            Data::Sym(s) if s.len() == 1 => s.clone(),
            _ => return Err("dictionary keys that are not symbols".into()),
        },
        _ => return Err("dictionary keys that are not symbols".into()),
    };
    let keys = keys
        .iter()
        .map(|k| column(k))
        .collect::<Result<Vec<_>, _>>()?;
    let vals: Vec<Node> = match &**v {
        Data::Enlist(one) => vec![node(one)?],
        Data::Sym(s) => s
            .iter()
            .map(|s| column(s).map(Node::Name))
            .collect::<Result<_, _>>()?,
        Data::List(items) => items.iter().map(node).collect::<Result<_, _>>()?,
        _ => return Err("dictionary values that are not a list".into()),
    };
    if keys.len() != vals.len() {
        return Err("a dictionary whose keys and values differ in count".into());
    }
    Ok(keys.into_iter().zip(vals).collect())
}

/// Column items written back: `n:e`, or `e` alone where q would name it
/// `n` anyway. q renames a repeated name (`q_name`), so each column is
/// written with a name that q turns into its own: `` `a`a1`a1 `` is
/// `a:px, a1:size, a:sym`. Where no name does - `` `a`a ``, which q's
/// renaming never gives - nothing is written (#2062).
fn column_text(cols: &[(String, Node)]) -> Result<String, String> {
    let mut bases: Vec<String> = vec![];
    let mut out = vec![];
    for (name, n) in cols {
        let text = one_item(infix_text(n)?);
        let implied = match derived(n) {
            Derived::Name(n) => Some(n),
            Derived::X => Some("x".into()),
            Derived::Unknown => None,
        };
        // The names q would turn into `name` here: itself, or what comes
        // before a count of how often it was written before.
        let mut candidates: Vec<String> = vec![name.clone()];
        let stem = name.trim_end_matches(|c: char| c.is_ascii_digit());
        for cut in stem.len()..name.len() {
            if !name[cut..].starts_with('0') && cut > 0 {
                candidates.push(name[..cut].to_string());
            }
        }
        let gives = |b: &String| q_name(&bases, b) == *name && column(b).is_ok();
        let base = if let Some(i) = implied.as_ref().filter(|i| gives(i)) {
            out.push(text);
            i.clone()
        } else if let Some(b) = candidates.iter().find(|b| gives(b)) {
            out.push(format!("{b}:{text}"));
            b.clone()
        } else {
            return Err(format!(
                "a column named `{name}` again, which q's qSQL would rename"
            ));
        };
        bases.push(base);
    }
    Ok(out.join(", "))
}

/// The functional form around byte `at` as qSQL; `None` where there is no
/// `?[...]` or `![...]` of four arguments around it, and the reason where
/// one cannot be written as qSQL.
///
/// The qSQL is in parentheses where the text around it would otherwise
/// join it: a name just before it fuses with the lead word
/// (`count?[t;..]` is not `countselect from t`, which q reads as one
/// name), and anything after it on the line, but a closing bracket or a
/// `;`, is read into its last clause (`?[..][`px]` is not
/// `select from t where px>2[`px]`, and `?[..],u` not
/// `select from t,u`) (#2061).
pub(crate) fn to_qsql_at(
    code: &str,
    source: &str,
    at: usize,
) -> Option<Result<Conversion, String>> {
    let b = code.as_bytes();
    Some(bare_qsql_at(code, source, at)?.map(|mut c| {
        let before = c.start.checked_sub(1).map(|i| b[i]);
        let after = b[c.end..]
            .iter()
            .find(|c| !matches!(c, b' ' | b'\t'))
            .copied();
        let joined_before =
            before.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.'));
        let joined_after = !matches!(
            after,
            None | Some(b'\n' | b'\r' | b';' | b')' | b']' | b'}')
        );
        if joined_before || joined_after {
            c.text = format!("({})", c.text);
        }
        c
    }))
}

/// As `to_qsql_at`, the qSQL alone, whatever is around it.
pub(crate) fn bare_qsql_at(
    code: &str,
    source: &str,
    at: usize,
) -> Option<Result<Conversion, String>> {
    let b = code.as_bytes();
    // The innermost `?[` or `![` whose bracket closes at or after `at`.
    let mut best: Option<(usize, usize)> = None;
    let mut i = (at + 2).min(b.len());
    while i > 0 {
        i -= 1;
        if b[i] == b'['
            && i > 0
            && matches!(b[i - 1], b'?' | b'!')
            && let Some(close) = closing(b, i)
            && close + 1 >= at
        {
            best = Some((i - 1, close));
            break;
        }
        // Stop at the start of the statement.
        if b[i] == b'\n' && !code[i + 1..].starts_with([' ', '\t', '\r']) {
            break;
        }
    }
    let (start, close) = best?;
    let args = split_args(&source[start + 2..close]);
    if args.len() != 4 {
        return None;
    }
    let verb = b[start];
    Some(from_functional(verb, &args).map(|text| Conversion {
        start,
        end: close + 1,
        text,
    }))
}

/// The bracket that closes the one at `open`, in the code view.
fn closing(b: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, &c) in b.iter().enumerate().skip(open) {
        match c {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// `text` split at its top-level semicolons.
fn split_args(text: &str) -> Vec<&str> {
    let mut out = vec![];
    let (mut depth, mut start, mut string) = (0i32, 0, false);
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' if string => i += 1,
            b'"' => string = !string,
            b'(' | b'[' | b'{' if !string => depth += 1,
            b')' | b']' | b'}' if !string => depth -= 1,
            b';' if !string && depth == 0 => {
                out.push(text[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(text[start..].trim());
    out
}

fn from_functional(verb: u8, args: &[&str]) -> Result<String, String> {
    let table = args[0];
    if table.is_empty() {
        return Err("a functional form with no table".into());
    }
    // `(t)` is the table `t`, but the parentheses around anything more are
    // the query's: `select from select from t where px>1 where size>20`
    // is 'type, where `select from (select ...) where size>20` runs (#2058).
    let table = table
        .strip_prefix('(')
        .and_then(|t| t.strip_suffix(')'))
        .map(str::trim)
        .filter(|t| {
            let name = t.strip_prefix('`').unwrap_or(t);
            !name.is_empty()
                && !keyword(name)
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'/'))
        })
        .unwrap_or(table);
    written(
        verb,
        table,
        &data(args[1])?,
        &data(args[2])?,
        &data(args[3])?,
    )
}

/// The qSQL of a functional form: its verb, its table as text, and its
/// where, by and column arguments.
fn written(verb: u8, table: &str, c: &Data, b: &Data, a: &Data) -> Result<String, String> {
    let wheres = where_list(c)?
        .iter()
        .map(|n| infix_text(n).map(one_item))
        .collect::<Result<Vec<_>, _>>()?;
    let tail = if wheres.is_empty() {
        String::new()
    } else {
        format!(" where {}", wheres.join(", "))
    };
    let by_text = |b: &Data| -> Result<String, String> {
        Ok(match b {
            Data::Leaf(l) if l == "0b" => String::new(),
            Data::List(items) if items.is_empty() => String::new(),
            Data::Sym(s) if s.len() == 1 => format!(" by {}", column(&s[0])?),
            other => format!(" by {}", column_text(&dict_items(other)?)?),
        })
    };
    match verb {
        b'?' => {
            let exec = matches!(&b, Data::List(items) if items.is_empty())
                || matches!(&b, Data::Sym(s) if s.len() == 1)
                || !matches!(a, Data::Dict(..) | Data::List(_));
            if exec {
                let cols = match &a {
                    Data::Dict(..) => column_text(&dict_items(a)?)?,
                    other => one_item(infix_text(&node(other)?)?),
                };
                // An exec's one group unnamed is the list itself, `,`sym`,
                // which keys the result by its values; named, it is the
                // dictionary `(,`sym)!,`sym`, which keys it by a table. So
                // a dictionary of one group is written with its name, even
                // where it is the one q would give it (#2059).
                let by = match b {
                    Data::Dict(..) => match &dict_items(b)?[..] {
                        [(name, n)] => format!(" by {name}:{}", one_item(infix_text(n)?)),
                        _ => by_text(b)?,
                    },
                    _ => by_text(b)?,
                };
                return Ok(format!("exec {cols}{by} from {table}{tail}"));
            }
            let distinct = matches!(&b, Data::Leaf(l) if l == "1b");
            // A column named as a group is 'dup names for cols/groups in a
            // select, though the functional form runs (#1301).
            if let (Data::Dict(..), Data::Dict(..)) = (&b, &a) {
                let groups = dict_items(b)?;
                if let Some((dup, _)) = dict_items(a)?
                    .into_iter()
                    .find(|(n, _)| groups.iter().any(|(g, _)| g == n))
                {
                    return Err(format!(
                        "a column `{dup}` named as a group too, which a select refuses: \
                         'dup names for cols/groups"
                    ));
                }
            }
            let cols = match &a {
                Data::List(items) if items.is_empty() => String::new(),
                other => column_text(&dict_items(other)?)?,
            };
            let lead = if distinct {
                "select distinct"
            } else {
                "select"
            };
            let by = if distinct { String::new() } else { by_text(b)? };
            let gap = if cols.is_empty() { "" } else { " " };
            Ok(format!("{lead}{gap}{cols}{by} from {table}{tail}"))
        }
        _ => match &a {
            Data::NoSymbols => Ok(format!("delete from {table}{tail}")),
            Data::Sym(s) if wheres.is_empty() => {
                let names = s.iter().map(|n| column(n)).collect::<Result<Vec<_>, _>>()?;
                Ok(format!("delete {} from {table}", names.join(",")))
            }
            Data::Enlist(one)
                if wheres.is_empty() && matches!(&**one, Data::Sym(s) if s.len() == 1) =>
            {
                let Data::Sym(s) = &**one else { unreachable!() };
                Ok(format!("delete {} from {table}", column(&s[0])?))
            }
            Data::Dict(..) => Ok(format!(
                "update {}{} from {table}{tail}",
                column_text(&dict_items(a)?)?,
                by_text(b)?
            )),
            _ => Err("a `![...]` that is neither an update nor a delete".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Tok, tokens};

    /// A number's tokens are q's own: each literal here with the tokens
    /// `-4!` gives for it on KDB-X 5, blanks left out (#2057).
    #[test]
    fn a_number_is_read_as_q_tokenizes_it() {
        let cases: &[(&str, &[&str])] = &[
            ("1e-3", &["1e-3"]),
            ("2.5e-1", &["2.5e-1"]),
            ("1e+1", &["1e+1"]),
            ("1e3", &["1e3"]),
            ("2e10", &["2e10"]),
            ("2e+10", &["2e+10"]),
            ("1.e-3", &["1.e-3"]),
            (".5e-3", &[".5e-3"]),
            ("-1e-3", &["-1e-3"]),
            ("-2.5e+2", &["-2.5e+2"]),
            ("10e-1", &["10e-1"]),
            ("1e-3e", &["1e-3e"]),
            ("1e-3e-2", &["1e-3e-2"]),
            ("1e-3f", &["1e-3f"]),
            ("1E-3", &["1E", "-", "3"]),
            ("1E3", &["1E3"]),
            ("1e--3", &["1e-", "-", "3"]),
            ("1e+-3", &["1e", "+", "-3"]),
            ("1e-", &["1e-"]),
            ("1e+", &["1e", "+"]),
            ("1e+x", &["1e", "+", "x"]),
            ("1e+.5", &["1e", "+", ".5"]),
            ("1e-+3", &["1e-", "+", "3"]),
            ("1e3-2", &["1e3", "-", "2"]),
            ("1f-3", &["1f", "-", "3"]),
            ("1b-3", &["1b", "-", "3"]),
            ("1d-3", &["1d", "-", "3"]),
            ("0x1e-3", &["0x1e-3"]),
            ("0Ne-3", &["0Ne-3"]),
            ("0we-1", &["0we-1"]),
            ("x*1e-3", &["x", "*", "1e-3"]),
            ("px>1e-3", &["px", ">", "1e-3"]),
            ("1e-3-2", &["1e-3", "-", "2"]),
            ("3-1e-3", &["3", "-", "1e-3"]),
            ("1e-3*2", &["1e-3", "*", "2"]),
            ("1e-3+1e+3", &["1e-3", "+", "1e+3"]),
            ("px-1e-3", &["px", "-", "1e-3"]),
            ("x-2e", &["x", "-", "2e"]),
            ("1e1e-1", &["1e1e-1"]),
            ("2e-3j", &["2e-3j"]),
            ("1he-2", &["1he-2"]),
            ("2012.01.01e-3", &["2012.01.01e-3"]),
            // q's tokens for a vector are its items; here they are one
            // literal, as `parse` holds them.
            ("1.5e-2 1e-1 3", &["1.5e-2 1e-1 3"]),
            ("1e-3 2", &["1e-3 2"]),
        ];
        for (text, want) in cases {
            let got: Vec<String> = tokens(text)
                .unwrap_or_else(|e| panic!("{text}: {e}"))
                .into_iter()
                .map(|t| match t {
                    Tok::Leaf(s) | Tok::Name(s) | Tok::Op(s) => s,
                    other => panic!("{text}: {other:?}"),
                })
                .collect();
            assert_eq!(got, *want, "{text}");
        }
    }
}
