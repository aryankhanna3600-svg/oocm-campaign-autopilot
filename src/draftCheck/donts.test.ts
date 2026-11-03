import { describe, expect, it } from "vitest";
import { displayProduct, scoreDonts, splitDonts, type Brief } from "./draftCheck";

const brief = (product: string, brand = "GlowCo"): Brief => ({
  brand, product, mustSay: [], mustShow: [], competitors: [],
});

describe("displayProduct", () => {
  it("falls back to the brand, then to 'The product', never a leading blank", () => {
    expect(displayProduct(brief("", "GlowCo"))).toBe("GlowCo");
    expect(displayProduct(brief("  ", ""))).toBe("The product");
    expect(displayProduct(brief("serum bottle"))).toBe("serum bottle");
  });
});

describe("splitDonts", () => {
  it("splits prose, numbered and bulleted don'ts into one item each", () => {
    expect(splitDonts("No Lumen Skin; keep it fun\n2. No price talk")).toEqual([
      "No Lumen Skin", "keep it fun", "No price talk",
    ]);
    expect(splitDonts(null)).toEqual([]);
    expect(splitDonts("  ")).toEqual([]);
  });

  it("splits Campaign 3123's three sentences into three items", () => {
    const text = "Please don't promise people they will earn money. Don't show other people's chats or earnings. Don't mention other apps like ours.";
    const items = splitDonts(text);
    expect(items).toHaveLength(3);
    expect(items).toEqual([
      "Please don't promise people they will earn money",
      "Don't show other people's chats or earnings",
      "Don't mention other apps like ours",
    ]);
  });
});

describe("scoreDonts", () => {
  it("a clearly broken don't fails with the model's time and quote, and the rule is not repeated", () => {
    const { items, consumed } = scoreDonts(["No Lumen Skin", "Keep it fun"], [
      { rule: "Shows Lumen Skin bottle", at_s: 16, why: "Lumen Skin is on screen", quote: "Lumen Skin" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      key: "dont_1", label: "Doesn't: No Lumen Skin", verdict: "fail", at_s: 16, quote: "Lumen Skin",
    });
    expect(items[1]).toMatchObject({ key: "dont_2", verdict: "pass", at_s: null, quote: null });
    expect(consumed).toEqual([0]);
  });

  it("a weak match needs a human eye instead of failing", () => {
    const { items } = scoreDonts(["alpha beta delta epsilon"], [{ rule: "alpha", at_s: 5, why: "zeta", quote: null }]);
    expect(items[0].verdict).toBe("needs_review");
    expect(items[0].at_s).toBe(5);
  });

  it("an untouched don't passes, and a long one is shortened in the label", () => {
    const long = "Do not under any circumstances mention the price before the final three seconds of the video";
    const { items } = scoreDonts([long], []);
    expect(items[0].verdict).toBe("pass");
    expect(items[0].label.startsWith("Doesn't: ")).toBe(true);
    expect(items[0].label.length).toBeLessThan(long.length);
    expect(items[0].detail).toContain("Keeps clear of");
  });

  it("a partial-word rule never matches (no false fail)", () => {
    const { items, consumed } = scoreDonts(["alpha beta delta"], [{ rule: "zeta", at_s: 1, why: "eta theta", quote: null }]);
    expect(items[0].verdict).toBe("pass");
    expect(consumed).toEqual([]);
  });
});
