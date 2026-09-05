import { describe, expect, test } from "bun:test"
import {
  normalizeJsonParamForTest as normalize,
  normalizeTextParamForTest as normalizeText,
} from "@opencode-ai/core/database/pg-effect-db"

/**
 * Postgres `jsonb` is stricter than SQLite `TEXT` about what a JSON string may
 * contain. `JSON.stringify` will happily emit `\u0000` and unpaired
 * surrogates, but the server rejects both:
 *
 *   - NUL                -> unsupported Unicode escape sequence
 *   - unpaired surrogate -> invalid input syntax for type json
 *
 * Any tool that puts undecoded binary into a part payload (observed with
 * `webfetch` on a PDF) therefore aborted the whole `insert into "part" ...`
 * mid-turn and killed the run, surfacing only as drizzle's misleading
 * `params: ...,[object Object]` render.
 *
 * These tests pin the write-side normalizer that makes such payloads safe.
 */
describe("pg json param normalizer", () => {
  const stringify = (value: unknown) => JSON.stringify(normalize(value))

  test("strips NUL bytes from strings", () => {
    expect(normalize({ output: "%PDF-1.7\u0000\u0000stream\u0000bin" })).toEqual({
      output: "%PDF-1.7streambin",
    })
  })

  test("replaces an unpaired high surrogate with U+FFFD", () => {
    expect(normalize({ output: "bad\uD800 hi" })).toEqual({ output: "bad\uFFFD hi" })
  })

  test("replaces an unpaired low surrogate with U+FFFD", () => {
    expect(normalize({ output: "bad\uDC00 lo" })).toEqual({ output: "bad\uFFFD lo" })
  })

  test("preserves valid surrogate pairs (emoji / astral characters)", () => {
    // A rocket is a real surrogate pair and must survive byte-for-byte.
    expect(normalize({ output: "rocket 🚀 ok" })).toEqual({ output: "rocket 🚀 ok" })
  })

  test("coerces bigint to number so JSON.stringify cannot throw", () => {
    expect(normalize({ tokens: 123n })).toEqual({ tokens: 123 })
    expect(() => stringify({ tokens: 123n })).not.toThrow()
  })

  test("sanitizes recursively through nested objects and arrays", () => {
    expect(normalize({ items: ["x\u0000y", { deep: "z\uD800", arr: ["q\u0000"] }] })).toEqual({
      items: ["xy", { deep: "z\uFFFD", arr: ["q"] }],
    })
  })

  test("preserves a Date's toJSON form", () => {
    expect(normalize({ at: new Date("2026-09-05T18:27:18Z") })).toEqual({ at: "2026-09-05T18:27:18.000Z" })
  })

  test("sanitizes a dirty string returned by a custom toJSON", () => {
    // The old implementation early-returned any object with a toJSON method,
    // which let a dirty string straight through to the server.
    const dirty = { toJSON: () => "bad\u0000\uD800value" }
    expect(normalize({ nested: dirty })).toEqual({ nested: "bad\uFFFDvalue" })
  })

  test("leaves clean payloads untouched and non-objects alone", () => {
    const clean = { type: "text", text: "hello world", n: 1, ok: true, nil: null }
    expect(normalize(clean)).toEqual(clean)
    expect(normalize(null)).toBeNull()
    expect(normalize("plain")).toBe("plain")
  })

  test("output is always JSON-serializable for the driver", () => {
    const hostile = {
      tokens: 9007199254740993n,
      state: { output: "a\u0000b\uD800c", at: new Date("2026-09-05T18:27:18Z") },
      items: ["\u0000", "\uDC00", "🚀"],
    }
    expect(() => stringify(hostile)).not.toThrow()
    const round = JSON.parse(stringify(hostile))
    expect(round.state.output).toBe("ab\uFFFDc")
    expect(round.items).toEqual(["", "\uFFFD", "🚀"])
  })
})

/**
 * `text` columns are exposed to a narrower version of the same class: Postgres
 * rejects a NUL byte in any text value with `invalid byte sequence for
 * encoding "UTF8": 0x00`. Lone surrogates are tolerated by the server here
 * (unlike jsonb), so they are deliberately left alone.
 */
describe("pg text param normalizer", () => {
  test("strips NUL bytes", () => {
    expect(normalizeText("a\u0000b")).toBe("ab")
  })

  test("leaves clean text byte-for-byte intact", () => {
    expect(normalizeText("a title 🚀")).toBe("a title 🚀")
  })

  test("passes non-strings through untouched", () => {
    const d = new Date()
    expect(normalizeText(42)).toBe(42)
    expect(normalizeText(null)).toBeNull()
    expect(normalizeText(undefined)).toBeUndefined()
    expect(normalizeText(d)).toBe(d)
  })
})
