import { describe, expect, it } from "vitest";
import { jsonEqual, JsonSyntaxError, parseJson, stringifyJson } from "@/io/json";
import type { JsonObject } from "@/model/json";

describe("parseJson", () => {
  it("keeps integer-like keys in document order (JSON.parse would move them first)", () => {
    const text = '{"walk": 1, "2": 2, "idle": 3, "1": 4}';
    expect(Object.keys(JSON.parse(text))).toEqual(["1", "2", "walk", "idle"]);
    expect([...(parseJson(text) as JsonObject).keys()]).toEqual(["walk", "2", "idle", "1"]);
  });
  it("keeps a duplicate key's first place and its last value", () => {
    expect([...(parseJson('{"a": 1, "b": 2, "a": 3}') as JsonObject)]).toEqual([["a", 3], ["b", 2]]);
  });
  it.each([
    ['"a\\u00e9\\n\\"b"', 'aé\n"b'],
    ["-1.5e-3", -0.0015],
    ["[1, [], {}]", [1, [], new Map()]],
    ["﻿ true ", true],
    ["null", null],
  ])("reads %s", (text, want) => expect(parseJson(text)).toEqual(want));
  it.each(["{", "[1,]", "{'a': 1}", "01", "1 2", '"\u0001"', "tru"])("refuses %s", (text) => {
    expect(() => parseJson(text)).toThrow(JsonSyntaxError);
  });
});

describe("stringifyJson", () => {
  it("writes back what it read, keys in order, numbers exactly", () => {
    const text = '{"b": [0.1, -0, 1e-7, 123456.789], "a": {"2": "x", "1": null}, "c": [{"t": true}]}';
    const back = parseJson(stringifyJson(parseJson(text)));
    expect(jsonEqual(parseJson(text), back)).toBe(true);
    expect([...((back as JsonObject).get("a") as JsonObject).keys()]).toEqual(["2", "1"]);
  });
  it("writes one line without indent", () => {
    expect(stringifyJson(parseJson('{"a": [1, {"b": 2}]}'), "")).toBe('{"a":[1,{"b":2}]}');
  });
});

describe("jsonEqual", () => {
  const a = parseJson('{"x": 1, "y": 2}'), b = parseJson('{"y": 2, "x": 1}');
  it("can ignore key order, or not", () => {
    expect(jsonEqual(a, b, () => false)).toBe(true);
    expect(jsonEqual(a, b)).toBe(false);
  });
  it("names the first difference", () => {
    let why = "";
    jsonEqual(parseJson('{"k": [1, 2]}'), parseJson('{"k": [1, 3]}'), () => true, (d) => { why = d; });
    expect(why).toBe("k/1: 2 vs 3");
  });
});
