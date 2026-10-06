import { type AST, getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

export function tomlKey(...parts: string[]): string {
  return parts
    .map((part) =>
      /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part),
    )
    .join(".");
}

export function tomlKeyParts(key: string): string[] {
  const node = parseTOML(`${key} = 0`, { tomlVersion: "1.0" }).body[0].body[0];

  if (node.type !== "TOMLKeyValue")
    throw new Error("Expected a TOML config key.");

  return getStaticTOMLValue(node.key);
}

/** Small source edits through TOML's AST; do not serialize unrelated user values. */
export class TomlEdits {
  constructor(public source: string) {}

  private index() {
    const ast = parseTOML(this.source, { tomlVersion: "1.0" });
    const fields = new Map<string, AST.TOMLKeyValue>();
    const tables = new Map<string, AST.TOMLTable>();

    const field = (node: AST.TOMLKeyValue, prefix: string[]) => {
      const key = [...prefix, ...getStaticTOMLValue(node.key)];
      fields.set(tomlKey(...key), node);

      if (node.value.type === "TOMLInlineTable")
        for (const child of node.value.body) field(child, key);
    };

    for (const node of ast.body[0].body) {
      if (node.type === "TOMLKeyValue") field(node, []);
      else {
        const key = node.resolvedKey.map(String);
        tables.set(tomlKey(...key), node);

        for (const child of node.body) field(child, key);
      }
    }

    return { ast, fields, tables };
  }

  keys(): string[] {
    return [...this.index().fields.keys()];
  }

  valueKeys(): string[] {
    return [...this.index().fields].flatMap(([key, node]) =>
      node.value.type === "TOMLInlineTable" ? [] : [key],
    );
  }

  value(key: string) {
    const node = this.index().fields.get(key);

    return node && getStaticTOMLValue(node.value);
  }

  /** Retained settings must keep their exact saved value, including prompt spacing. */
  assertUnchanged(
    original: string,
    keys: readonly (readonly [string, string])[],
  ): void {
    const before = new TomlEdits(original).index().fields;
    const after = this.index().fields;

    for (const [from, to] of keys) {
      const previous = before.get(from);
      const current = after.get(to);
      const previousText = previous && original.slice(...previous.value.range);
      const currentText = current && this.source.slice(...current.value.range);

      if (previousText !== currentText)
        throw new Error(`diffr migration changed a retained setting: ${from}`);
    }
  }

  /** Move a config subtree without serializing any of its saved values. */
  move(from: string, to: string): void {
    const { fields, tables } = this.index();
    const matches = (key: string) => key === from || key.startsWith(`${from}.`);

    if (
      [...fields.keys(), ...tables.keys()].some(
        (key) => key === to || key.startsWith(`${to}.`),
      )
    )
      throw new Error(`diffr migration has conflicting config entries: ${to}`);

    const direct = fields.get(from);

    if (direct) {
      const literal = this.source.slice(...direct.value.range);
      this.remove(from, false);
      this.setLiteral(to, literal);

      return;
    }

    const moves: { start: number; end: number; text: string }[] = [];
    const movedTables = [...tables].filter(([key]) => matches(key));

    for (const [key, table] of movedTables)
      moves.push({
        start: table.key.range[0],
        end: table.key.range[1],
        text: `${to}${key.slice(from.length)}`,
      });

    const dotted: [string, string][] = [];

    for (const [key, field] of fields) {
      if (!matches(key) || field.parent.type === "TOMLInlineTable") continue;

      // Fields in a moved table keep their original spelling and comments.
      if (
        field.parent.type === "TOMLTable" &&
        movedTables.some(([, table]) => table === field.parent)
      )
        continue;
      dotted.push([
        `${to}${key.slice(from.length)}`,
        this.source.slice(...field.value.range),
      ]);
      moves.push({ start: field.range[0], end: field.range[1], text: "" });
    }

    for (const edit of moves.sort((a, b) => b.start - a.start))
      this.replace(edit.start, edit.end, edit.text);

    for (const [key, literal] of dotted) this.setLiteral(key, literal);
  }

  remove(key: string, retainComments = true): void {
    while (true) {
      const { ast, fields, tables } = this.index();

      const matches = (name: string) =>
        name === key || name.startsWith(`${key}.`);

      const node =
        fields.get(key) ??
        [...tables].find(([name]) => matches(name))?.[1] ??
        [...fields].find(([name]) => matches(name))?.[1];

      if (!node) return;
      let [start, end] = node.range;

      if (
        node.type === "TOMLKeyValue" &&
        node.parent.type === "TOMLInlineTable"
      ) {
        const siblings = node.parent.body;
        const position = siblings.indexOf(node);
        const next = siblings[position + 1];
        const previous = siblings[position - 1];

        if (next) {
          const comma = ast.tokens.find(
            (token) =>
              token.value === "," &&
              token.range[0] >= end &&
              token.range[0] < next.range[0],
          );

          if (comma) end = comma.range[1];
        } else if (previous) {
          const comma = ast.tokens.find(
            (token) =>
              token.value === "," &&
              token.range[0] >= previous.range[1] &&
              token.range[0] < start,
          );

          if (comma) start = comma.range[0];
        }
      }

      const comments = retainComments
        ? ast.comments
            .filter(
              (comment) => comment.range[0] >= start && comment.range[1] <= end,
            )
            .map((comment) => this.source.slice(...comment.range))
            .join("\n")
        : "";

      this.replace(start, end, comments);
    }
  }

  set(key: string, value: boolean | number | string | string[]): void {
    this.setLiteral(key, JSON.stringify(value), Array.isArray(value));
  }

  private setLiteral(key: string, input: string, retainComments = false): void {
    const { ast, fields, tables } = this.index();
    let literal = input;
    const existing = fields.get(key);

    if (existing) {
      // Keep notes between entries when a plugin order is rewritten.
      if (retainComments) {
        const comments = ast.comments
          .filter(
            (comment) =>
              comment.range[0] >= existing.value.range[0] &&
              comment.range[1] <= existing.value.range[1],
          )
          .map((comment) => this.source.slice(...comment.range));

        if (comments.length)
          literal = `[\n${comments.join("\n")}\n${literal.slice(1)}`;
      }

      this.replace(...existing.value.range, literal);

      return;
    }

    const parts = tomlKeyParts(key);

    for (let length = parts.length - 1; length > 0; length--) {
      const parent = tomlKey(...parts.slice(0, length));
      const suffix = tomlKey(...parts.slice(length));
      const inline = fields.get(parent)?.value;

      if (inline?.type === "TOMLInlineTable") {
        this.replace(
          inline.range[1] - 1,
          inline.range[1] - 1,
          `${inline.body.length ? ", " : ""}${suffix} = ${literal}`,
        );

        return;
      }

      const table = tables.get(parent);

      if (table) {
        const newline = this.source.indexOf("\n", table.key.range[1]);
        const at = newline < 0 ? this.source.length : newline + 1;
        this.replace(
          at,
          at,
          `${newline < 0 ? "\n" : ""}${suffix} = ${literal}\n`,
        );

        return;
      }
    }

    this.source = `${key} = ${literal}\n${this.source}`;
  }

  private replace(start: number, end: number, text: string): void {
    this.source = this.source.slice(0, start) + text + this.source.slice(end);
  }
}
