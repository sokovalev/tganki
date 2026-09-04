import { describe, expect, it } from "vitest";
import { parseDeckFile, toNoteRows } from "../src/seed/decks.js";

const valid = {
  slug: "en-ru-top-1000-a1",
  title: "English Top 1000 · A1",
  description: "First thousand words",
  lang_from: "en",
  lang_to: "ru",
  level: "A1",
  notes: [
    {
      front: "reluctant",
      back: "неохотный",
      transcription: "rɪˈlʌktənt",
      example: "She was reluctant to go.",
      example_tr: "Она не хотела идти.",
      tags: ["adjective"],
    },
    { front: "two", back: "два" },
  ],
};

describe("parseDeckFile", () => {
  it("accepts the deck contract and defaults optional fields", () => {
    const deck = parseDeckFile(valid, "deck.json");
    expect(deck.slug).toBe("en-ru-top-1000-a1");
    expect(deck.notes[1]).toEqual({ front: "two", back: "два", tags: [] });
  });

  it("rejects a non-kebab-case slug", () => {
    expect(() => parseDeckFile({ ...valid, slug: "EN RU" }, "deck.json")).toThrow(/kebab-case/);
  });

  it("rejects a deck without notes", () => {
    expect(() => parseDeckFile({ ...valid, notes: [] }, "deck.json")).toThrow(/Invalid deck file/);
  });

  it("rejects a note without a back side", () => {
    expect(() => parseDeckFile({ ...valid, notes: [{ front: "a" }] }, "deck.json")).toThrow(
      /notes\.0\.back/,
    );
  });
});

describe("toNoteRows", () => {
  it("numbers notes by file order and normalizes optional fields", () => {
    const rows = toNoteRows(4, parseDeckFile(valid, "deck.json").notes);
    expect(rows).toEqual([
      {
        deckId: 4,
        front: "reluctant",
        back: "неохотный",
        transcription: "rɪˈlʌktənt",
        example: "She was reluctant to go.",
        exampleTr: "Она не хотела идти.",
        tags: ["adjective"],
        position: 0,
      },
      {
        deckId: 4,
        front: "two",
        back: "два",
        transcription: null,
        example: null,
        exampleTr: null,
        tags: [],
        position: 1,
      },
    ]);
  });

  it("drops duplicate fronts, keeping the first and a gapless position", () => {
    const rows = toNoteRows(1, [
      { front: "a", back: "1", tags: [] },
      { front: "b", back: "2", tags: [] },
      { front: "a", back: "3", tags: [] },
      { front: "c", back: "4", tags: [] },
    ]);
    expect(rows.map((r) => [r.front, r.back, r.position])).toEqual([
      ["a", "1", 0],
      ["b", "2", 1],
      ["c", "4", 2],
    ]);
  });
});
