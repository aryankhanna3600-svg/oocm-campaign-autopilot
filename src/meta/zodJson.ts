/**
 * zod (v4) → JSON Schema, for the Meta Responses API's structured output.
 *
 * The builder's four schemas (BrandProfile, OptionsOutput, ReviewOutput,
 * CompetitorPick) are zod v4. This converter reads their `_zod.def` ducks —
 * no zod import, so this module stays dependency-free — and emits strict-mode
 * JSON Schema (additionalProperties false, every non-optional key required).
 *
 * Deliberately narrow: anything outside object/array/string/number/boolean/
 * enum/nullable/optional/describe throws UnsupportedZodConstruct with the
 * field path. A silently-dropped constraint would be worse than a loud stop:
 * the builder would grade briefs against a shape nobody reviewed.
 *
 * Built during the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).
 */

export class UnsupportedZodConstruct extends Error {
  readonly path: string;
  readonly construct: string;
  constructor(path: string, construct: string) {
    super(`zodToJsonSchema: unsupported construct "${construct}" at "${path || "<root>"}". Add it or simplify the schema.`);
    this.name = "UnsupportedZodConstruct";
    this.path = path;
    this.construct = construct;
  }
}

type JsonSchema = Record<string, unknown>;

const defOf = (schema: unknown): any => (schema as any)?._zod?.def;

// nullable/optional are unwrapped by the walker below; convertInner sees only
// concrete nodes and throws loud on anything else.
function convertInner(schema: unknown, path: string): JsonSchema {
  const def = defOf(schema);
  const t = def?.type;
  // zod v4 .describe() lives on the schema object (and the global registry),
  // NOT in _zod.def — read it directly, at every level including wrappers.
  const own = (schema as any)?.description;
  const desc = typeof own === "string" && own ? { description: own } : {};

  switch (t) {
    case "object": {
      const shape = (schema as any).shape as Record<string, unknown>;
      if (!shape || typeof shape !== "object") throw new UnsupportedZodConstruct(path, "object-without-shape");
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const sub = `${path ? `${path}.` : ""}${k}`;
        const n = nodeOf(v, sub);
        properties[k] = n.schema;
        if (!n.optional) required.push(k);
      }
      return { type: "object", properties, required, additionalProperties: false, ...desc };
    }
    case "array": {
      if (!def.element) throw new UnsupportedZodConstruct(path, "array-without-element");
      return { type: "array", items: nodeOf(def.element, `${path}[]`).schema, ...desc };
    }
    case "string":
      return { type: "string", ...desc };
    case "number": {
      const checks: any[] = Array.isArray(def.checks) ? def.checks : [];
      // Only an explicit .int() is integer. Plain bounds (.min()/.max()) are
      // ranges, not int-ness, so they stay numeric.
      const isInt = checks.some((c) => {
        const d = c?._zod?.def;
        return d && (d.check === "number_format" || d.format === "safeint");
      });
      return { type: isInt ? "integer" : "number", ...desc };
    }
    case "boolean":
      return { type: "boolean", ...desc };
    case "enum": {
      const values = def.entries ? Object.values(def.entries) : def.values ?? def.options;
      if (!Array.isArray(values) || !values.length || !values.every((v) => typeof v === "string")) {
        throw new UnsupportedZodConstruct(path, "non-string-enum");
      }
      return { type: "string", enum: values, ...desc };
    }
    default:
      throw new UnsupportedZodConstruct(path, String(t));
  }
}

/** Unwrap optional (→ requiredness) and nullable (→ type union) at any level. */
function nodeOf(s: unknown, path: string): { schema: JsonSchema; optional: boolean } {
  const def = defOf(s);
  if (def?.type === "optional") {
    const inner = nodeOf(def.innerType, path);
    return { schema: withDesc(inner.schema, s), optional: true };
  }
  if (def?.type === "nullable") {
    const inner = nodeOf(def.innerType, path);
    const it = (inner.schema as any).type;
    return { schema: withDesc({ ...inner.schema, type: Array.isArray(it) ? [...it, "null"] : [it, "null"] }, s), optional: inner.optional };
  }
  return { schema: convertInner(s, path), optional: false };
}

/** A wrapper's own .describe() (e.g. z.string().nullable().describe("…")). */
function withDesc(schema: JsonSchema, s: unknown): JsonSchema {
  const own = (s as any)?.description;
  if (typeof own !== "string" || !own) return schema;
  return { ...schema, description: own };
}

/**
 * Convert a zod v4 object schema to strict-mode JSON Schema.
 * nullable → {type: [..., "null"]}: strict mode allows the union form.
 */
export function zodToJsonSchema(schema: unknown): JsonSchema {
  const n = nodeOf(schema, "");
  if ((n.schema as any).type !== "object") throw new UnsupportedZodConstruct("", "root-must-be-object");
  return n.schema;
}
