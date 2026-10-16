/**
 * Needl rule language: syntax tree and parser.
 *
 *   rule      := expr
 *   expr      := or ("->" expr)?                         right-associative implication
 *   or        := and ("or" and)*
 *   and       := binary ("and" binary)*
 *   binary    := unary (("until" | "unless") within? unary)?
 *   unary     := note unary
 *              | "not" unary | "never" unary | "next" unary
 *              | ("always" | "eventually") within? unary
 *              | "bind" NAME "=" PROVIDER "." EVENT "." FIELD "in" expr
 *              | primary
 *   within    := "within" DURATION                       e.g. 30s, 15m, 2h, 1d
 *   primary   := "(" expr ")" | "true" | "false" | event
 *   event     := PROVIDER "." EVENT ("(" condition ("," condition)* ")")? ("bind" NAME "=" FIELD)*
 *   condition := FIELD op value
 *   op        := "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "starts_with" | "in"
 *   value     := STRING | NUMBER | "true" | "false" | "$"NAME | NAME | "[" value ("," value)* "]"
 *   note      := "#" STRING                              English for the next part; "{1}", "{2}" … are its parts
 *
 * Event and field names are resolved against the catalogue by the checker, not here.
 */

export interface Span {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface Note {
  readonly text: string;
  readonly span: Span;
}

export interface Duration {
  readonly ms: number;
  readonly text: string;
  readonly span: Span;
}

export type Value =
  | { readonly type: "string"; readonly value: string; readonly span: Span }
  | { readonly type: "number"; readonly value: number; readonly span: Span }
  | { readonly type: "boolean"; readonly value: boolean; readonly span: Span }
  /** External binding: chosen by the user when the rule is set up. */
  | { readonly type: "param"; readonly name: string; readonly span: Span }
  /** Bound variable: captured from an event by `bind` while the rule runs. */
  | { readonly type: "var"; readonly name: string; readonly span: Span }
  | { readonly type: "list"; readonly items: readonly Value[]; readonly span: Span };

export type ComparisonOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "starts_with" | "in";

export interface Condition {
  readonly field: string;
  readonly fieldSpan: Span;
  readonly op: ComparisonOp;
  readonly value: Value;
  readonly span: Span;
}

/** `event bind name = field`: captures `field` from this event for the right side of the enclosing `->`. */
export interface EventBind {
  readonly name: string;
  readonly field: string;
  readonly span: Span;
}

interface NodeBase {
  readonly span: Span;
  readonly note?: Note;
}

export type Expr =
  | NodeBase & { readonly type: "event"; readonly provider: string; readonly event: string; readonly refSpan: Span; readonly conditions: readonly Condition[]; readonly binds: readonly EventBind[] }
  | NodeBase & { readonly type: "constant"; readonly value: boolean }
  | NodeBase & { readonly type: "not" | "never" | "next"; readonly operand: Expr }
  | NodeBase & { readonly type: "always" | "eventually"; readonly operand: Expr; readonly within?: Duration }
  | NodeBase & { readonly type: "and" | "or"; readonly operands: readonly Expr[] }
  | NodeBase & { readonly type: "implies"; readonly left: Expr; readonly right: Expr }
  | NodeBase & { readonly type: "until" | "unless"; readonly left: Expr; readonly right: Expr; readonly within?: Duration }
  /** `bind name = provider.event.field in body`: captures the field from the observation where this part is evaluated. */
  | NodeBase & { readonly type: "bind"; readonly name: string; readonly provider: string; readonly path: string; readonly sourceSpan: Span; readonly body: Expr };

export class RuleSyntaxError extends Error {
  constructor(message: string, readonly span: Span) {
    super(`${message} (line ${span.line}, column ${span.column})`);
    this.name = "RuleSyntaxError";
  }
}

type TokenType = "name" | "param" | "string" | "number" | "duration" | "note" | "symbol" | "end";

interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly value?: string | number;
  readonly span: Span;
}

const keywords = new Set([
  "always", "never", "eventually", "next", "until", "unless", "within", "not", "and", "or", "bind", "in",
  "contains", "starts_with", "true", "false",
]);
const durationUnits: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const maximumSourceLength = 20_000;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let lineStart = 0;
  const span = (start: number, end: number, startLine = line, startColumn = start - lineStart + 1): Span =>
    ({ start, end, line: startLine, column: startColumn });
  const readString = (start: number): { value: string; end: number } => {
    let index = start + 1;
    let value = "";
    while (index < source.length && source[index] !== "\"") {
      const character = source[index]!;
      if (character === "\n") throw new RuleSyntaxError("String is not closed before the end of the line", span(start, index));
      if (character === "\\") {
        const next = source[index + 1];
        if (next === "\"" || next === "\\") { value += next; index += 2; continue; }
        if (next === "n") { value += "\n"; index += 2; continue; }
        throw new RuleSyntaxError("Unsupported escape in string; use \\\" or \\\\", span(index, index + 2));
      }
      value += character;
      index += 1;
    }
    if (index >= source.length) throw new RuleSyntaxError("String is not closed", span(start, index));
    return { value, end: index + 1 };
  };
  while (offset < source.length) {
    const character = source[offset]!;
    if (character === "\n") { offset += 1; line += 1; lineStart = offset; continue; }
    if (/\s/.test(character)) { offset += 1; continue; }
    if (source.startsWith("//", offset)) {
      while (offset < source.length && source[offset] !== "\n") offset += 1;
      continue;
    }
    const start = offset;
    if (character === "#") {
      if (source[offset + 1] !== "\"") throw new RuleSyntaxError("A note is # followed by a quoted string, e.g. #\"after {1}, {2}\"", span(start, start + 1));
      const { value, end } = readString(offset + 1);
      tokens.push({ type: "note", text: source.slice(start, end), value, span: span(start, end) });
      offset = end;
      continue;
    }
    if (character === "\"") {
      const { value, end } = readString(offset);
      tokens.push({ type: "string", text: source.slice(start, end), value, span: span(start, end) });
      offset = end;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(offset));
    if (number !== null && (character !== "-" || /\d/.test(source[offset + 1] ?? ""))) {
      const unit = /^(ms|s|m|h|d)(?![A-Za-z0-9_])/.exec(source.slice(offset + number[0].length));
      if (unit !== null) {
        const amount = Number(number[0]);
        if (!Number.isInteger(amount) || amount <= 0) throw new RuleSyntaxError("Durations are whole positive numbers, e.g. 30m", span(start, start + number[0].length));
        const end = offset + number[0].length + unit[0].length;
        tokens.push({ type: "duration", text: source.slice(start, end), value: amount * durationUnits[unit[0]]!, span: span(start, end) });
        offset = end;
        continue;
      }
      if (/[A-Za-z_]/.test(source[offset + number[0].length] ?? "")) {
        throw new RuleSyntaxError(`Unknown duration unit in ${JSON.stringify(/^\S+/.exec(source.slice(offset))![0])}; use ms, s, m, h or d`, span(start, start + number[0].length));
      }
      tokens.push({ type: "number", text: number[0], value: Number(number[0]), span: span(start, offset + number[0].length) });
      offset += number[0].length;
      continue;
    }
    if (character === "$") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(offset + 1));
      if (name === null) throw new RuleSyntaxError("Expected a name after $", span(start, start + 1));
      const end = offset + 1 + name[0].length;
      tokens.push({ type: "param", text: source.slice(start, end), value: name[0], span: span(start, end) });
      offset = end;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(offset));
    if (name !== null) {
      tokens.push({ type: "name", text: name[0], span: span(start, offset + name[0].length) });
      offset += name[0].length;
      continue;
    }
    const symbol = ["->", "!=", "<=", ">=", "(", ")", "[", "]", ",", ".", "=", "<", ">"].find((candidate) => source.startsWith(candidate, offset));
    if (symbol === undefined) throw new RuleSyntaxError(`Unexpected character ${JSON.stringify(character)}`, span(start, start + 1));
    tokens.push({ type: "symbol", text: symbol, span: span(start, offset + symbol.length) });
    offset += symbol.length;
  }
  tokens.push({ type: "end", text: "end of rule", span: span(source.length, source.length) });
  return tokens;
}

function join(left: Span, right: Span): Span {
  return { start: left.start, end: right.end, line: left.line, column: left.column };
}

export function parseRule(source: string): Expr {
  if (source.length > maximumSourceLength) throw new RuleSyntaxError("Rule is too long", { start: 0, end: 0, line: 1, column: 1 });
  const tokens = tokenize(source);
  let position = 0;
  let depth = 0;
  const peek = (offset = 0): Token => tokens[Math.min(position + offset, tokens.length - 1)]!;
  const take = (): Token => tokens[position++] ?? tokens.at(-1)!;
  const isWord = (token: Token, word: string): boolean => token.type === "name" && token.text === word;
  const isSymbol = (token: Token, symbol: string): boolean => token.type === "symbol" && token.text === symbol;
  const expectSymbol = (symbol: string, context: string): Token => {
    const token = take();
    if (!isSymbol(token, symbol)) throw new RuleSyntaxError(`Expected "${symbol}" ${context}, found ${describe(token)}`, token.span);
    return token;
  };
  const expectWord = (word: string, context: string): Token => {
    const token = take();
    if (!isWord(token, word)) throw new RuleSyntaxError(`Expected "${word}" ${context}, found ${describe(token)}`, token.span);
    return token;
  };
  const expectName = (context: string): Token => {
    const token = take();
    if (token.type !== "name" || keywords.has(token.text)) throw new RuleSyntaxError(`Expected a name ${context}, found ${describe(token)}`, token.span);
    return token;
  };
  const guard = <T>(token: Token, parse: () => T): T => {
    depth += 1;
    if (depth > 64) throw new RuleSyntaxError("Rule nests too deeply", token.span);
    try { return parse(); } finally { depth -= 1; }
  };

  const parseWithin = (): Duration | undefined => {
    if (!isWord(peek(), "within")) return undefined;
    const keyword = take();
    const token = take();
    if (token.type !== "duration") throw new RuleSyntaxError(`Expected a duration after "within", such as 30m or 2h, found ${describe(token)}`, token.span);
    return { ms: token.value as number, text: token.text, span: join(keyword.span, token.span) };
  };

  /** Dotted name such as `ref.issue_key` or `tags.linear_issue`; stops before "(". */
  const parseDotted = (context: string): { text: string; span: Span } => {
    const first = expectName(context);
    let text = first.text;
    let span = first.span;
    while (isSymbol(peek(), ".") && peek(1).type === "name") {
      take();
      const part = take();
      text += `.${part.text}`;
      span = join(span, part.span);
    }
    return { text, span };
  };

  const parseValue = (): Value => {
    const token = take();
    if (token.type === "string") return { type: "string", value: token.value as string, span: token.span };
    if (token.type === "number") return { type: "number", value: token.value as number, span: token.span };
    if (token.type === "param") return { type: "param", name: token.value as string, span: token.span };
    if (isWord(token, "true") || isWord(token, "false")) return { type: "boolean", value: token.text === "true", span: token.span };
    if (token.type === "name" && !keywords.has(token.text)) return { type: "var", name: token.text, span: token.span };
    if (isSymbol(token, "[")) {
      const items: Value[] = [];
      if (!isSymbol(peek(), "]")) {
        items.push(parseValue());
        while (isSymbol(peek(), ",")) { take(); items.push(parseValue()); }
      }
      const close = expectSymbol("]", "to close the list");
      if (items.some((item) => item.type === "list")) throw new RuleSyntaxError("Lists cannot contain lists", token.span);
      return { type: "list", items, span: join(token.span, close.span) };
    }
    throw new RuleSyntaxError(`Expected a value (a "string", a number, true/false, a $choice or a bound name), found ${describe(token)}`, token.span);
  };

  const parseCondition = (): Condition => {
    const field = parseDotted("for a field");
    const opToken = take();
    let op: ComparisonOp;
    if (opToken.type === "symbol" && ["=", "!=", "<", "<=", ">", ">="].includes(opToken.text)) op = opToken.text as ComparisonOp;
    else if (opToken.type === "name" && ["contains", "starts_with", "in"].includes(opToken.text)) op = opToken.text as ComparisonOp;
    else throw new RuleSyntaxError(`Expected a comparison (=, !=, <, <=, >, >=, contains, starts_with, in) after ${field.text}, found ${describe(opToken)}`, opToken.span);
    const value = parseValue();
    return { field: field.text, fieldSpan: field.span, op, value, span: join(field.span, value.span) };
  };

  const parseEvent = (): Expr => {
    const provider = expectName("for an integration, such as gitlab or stripe");
    expectSymbol(".", `after ${provider.text}`);
    const event = parseDotted(`for a ${provider.text} event`);
    const refSpan = join(provider.span, event.span);
    let span = refSpan;
    const conditions: Condition[] = [];
    if (isSymbol(peek(), "(")) {
      take();
      if (!isSymbol(peek(), ")")) {
        conditions.push(parseCondition());
        while (isSymbol(peek(), ",")) { take(); conditions.push(parseCondition()); }
      }
      span = join(span, expectSymbol(")", "to close the event's conditions").span);
    }
    const binds: EventBind[] = [];
    while (isWord(peek(), "bind")) {
      const keyword = take();
      const name = expectName("for the bound value");
      expectSymbol("=", `after bind ${name.text}`);
      const field = parseDotted(`for the field ${name.text} is taken from`);
      binds.push({ name: name.text, field: field.text, span: join(keyword.span, field.span) });
      span = join(span, field.span);
    }
    return { type: "event", provider: provider.text, event: event.text, refSpan, conditions, binds, span };
  };

  const parsePrimary = (): Expr => {
    const token = peek();
    if (isSymbol(token, "(")) {
      take();
      const inner = guard(token, parseExpr);
      const close = expectSymbol(")", "to close the parenthesis");
      return { ...inner, span: join(token.span, close.span) };
    }
    if (isWord(token, "true") || isWord(token, "false")) {
      take();
      return { type: "constant", value: token.text === "true", span: token.span };
    }
    if (token.type === "name" && !keywords.has(token.text)) return parseEvent();
    throw new RuleSyntaxError(`Expected an event such as gitlab.deployment, found ${describe(token)}`, token.span);
  };

  const parseUnary = (): Expr => {
    const token = peek();
    if (token.type === "note") {
      take();
      const operand = guard(token, parseUnary);
      if (operand.note !== undefined) throw new RuleSyntaxError("A part can have only one note", token.span);
      return { ...operand, note: { text: token.value as string, span: token.span } };
    }
    if (isWord(token, "not") || isWord(token, "never") || isWord(token, "next")) {
      take();
      const operand = guard(token, parseUnary);
      return { type: token.text as "not" | "never" | "next", operand, span: join(token.span, operand.span) };
    }
    if (isWord(token, "always") || isWord(token, "eventually")) {
      take();
      const within = parseWithin();
      const operand = guard(token, parseUnary);
      return { type: token.text as "always" | "eventually", operand, ...(within === undefined ? {} : { within }), span: join(token.span, operand.span) };
    }
    if (isWord(token, "bind")) {
      take();
      const name = expectName("for the bound value");
      expectSymbol("=", `after bind ${name.text}`);
      const provider = expectName("for the integration the value comes from");
      expectSymbol(".", `after ${provider.text}`);
      const path = parseDotted(`for the ${provider.text} event and field`);
      expectWord("in", `after the field ${name.text} is taken from`);
      const body = guard(token, parseExpr);
      // `path` is "event.field"; the checker splits it against the catalogue, since event names can contain dots.
      return { type: "bind", name: name.text, provider: provider.text, path: path.text, sourceSpan: join(provider.span, path.span), body, span: join(token.span, body.span) };
    }
    return parsePrimary();
  };

  const parseBinary = (): Expr => {
    const left = parseUnary();
    const token = peek();
    if (!isWord(token, "until") && !isWord(token, "unless")) return left;
    take();
    const within = parseWithin();
    const right = guard(token, parseUnary);
    if (isWord(peek(), "until") || isWord(peek(), "unless")) {
      throw new RuleSyntaxError(`Chained ${token.text} is ambiguous; add parentheses`, peek().span);
    }
    return { type: token.text as "until" | "unless", left, right, ...(within === undefined ? {} : { within }), span: join(left.span, right.span) };
  };

  const parseList = (word: "and" | "or", next: () => Expr): Expr => {
    const operands = [next()];
    while (isWord(peek(), word)) { take(); operands.push(next()); }
    return operands.length === 1 ? operands[0]! : { type: word, operands, span: join(operands[0]!.span, operands.at(-1)!.span) };
  };

  function parseExpr(): Expr {
    const left = parseList("or", () => parseList("and", parseBinary));
    if (!isSymbol(peek(), "->")) return left;
    const arrow = take();
    const right = guard(arrow, parseExpr);
    return { type: "implies", left, right, span: join(left.span, right.span) };
  }

  if (peek().type === "end") throw new RuleSyntaxError("Rule is empty", peek().span);
  const rule = parseExpr();
  if (peek().type !== "end") throw new RuleSyntaxError(`Unexpected ${describe(peek())}; parts must be joined with and, or, ->, until or unless`, peek().span);
  return rule;
}

function describe(token: Token): string {
  if (token.type === "end") return "the end of the rule";
  return JSON.stringify(token.text);
}

/** Direct parts of a node in source order, used by notes ({1}, {2}, …) and by every tree walk. */
export type Part =
  | { readonly kind: "expr"; readonly expr: Expr }
  | { readonly kind: "value"; readonly value: Value; readonly condition: Condition }
  | { readonly kind: "duration"; readonly duration: Duration }
  | { readonly kind: "bindField"; readonly bind: EventBind }
  | { readonly kind: "bindSource"; readonly expr: Extract<Expr, { type: "bind" }> };

export function parts(expr: Expr): Part[] {
  switch (expr.type) {
    case "event": return [
      ...expr.conditions.map((condition): Part => ({ kind: "value", value: condition.value, condition })),
      ...expr.binds.map((bind): Part => ({ kind: "bindField", bind })),
    ];
    case "constant": return [];
    case "not":
    case "never":
    case "next": return [{ kind: "expr", expr: expr.operand }];
    case "always":
    case "eventually": return [...(expr.within === undefined ? [] : [{ kind: "duration", duration: expr.within } as const]), { kind: "expr", expr: expr.operand }];
    case "and":
    case "or": return expr.operands.map((operand): Part => ({ kind: "expr", expr: operand }));
    case "implies": return [{ kind: "expr", expr: expr.left }, { kind: "expr", expr: expr.right }];
    case "until":
    case "unless": return [
      { kind: "expr", expr: expr.left },
      ...(expr.within === undefined ? [] : [{ kind: "duration", duration: expr.within } as const]),
      { kind: "expr", expr: expr.right },
    ];
    case "bind": return [{ kind: "bindSource", expr }, { kind: "expr", expr: expr.body }];
  }
}

export function subExpressions(expr: Expr): Expr[] {
  return parts(expr).flatMap((part) => part.kind === "expr" ? [part.expr] : []);
}
