import { describe, expect, it } from "vitest";
import {
  backIncludesAny,
  exampleUsesFront,
  isInScript,
  isMostlyCyrillic,
  normalizeForCompare,
  passRate,
  runChecks,
  transcriptionIssue,
} from "../scripts/llm-eval/checks.js";
import {
  collapseWhitespace,
  extractJson,
  KA_IPA_CHARS,
  normalizeTranscription,
  parseCard,
  postProcess,
} from "../scripts/llm-eval/prompt.js";
import type { EvalCase } from "../scripts/llm-eval/types.js";
import type { GeneratedCard } from "../src/llm/types.js";

const kaCase: EvalCase = {
  id: "ka-conj-vkitxulob",
  text: "ვკითხულობ",
  langFrom: "ka",
  langTo: "ru",
  category: "inflected",
  expect: { detectedLang: "ka", front: "კითხვა", pos: "verb", backIncludesAny: ["чита"] },
};

const kaCard: GeneratedCard = {
  front: "კითხვა",
  back: "читать; спрашивать",
  transcription: "kʼitʰxvɑ",
  example: "წიგნს ვკითხულობ.",
  exampleTr: "Я читаю книгу.",
  pos: "verb",
  detectedLang: "ka",
};

function byName(results: readonly { name: string; pass: boolean }[]): Record<string, boolean> {
  return Object.fromEntries(results.map((item) => [item.name, item.pass]));
}

describe("post-processing", () => {
  it("collapses whitespace everywhere", () => {
    expect(collapseWhitespace("  der   Tisch \n")).toBe("der Tisch");
  });

  it("strips slashes and brackets around a transcription", () => {
    expect(normalizeTranscription("/kʼitʰxvɑ/")).toBe("kʼitʰxvɑ");
    expect(normalizeTranscription("[ˈmʊtɐ]")).toBe("ˈmʊtɐ");
    expect(normalizeTranscription("[/ˈmʊtɐ/]")).toBe("ˈmʊtɐ");
    expect(normalizeTranscription("kʼitʰxvɑ")).toBe("kʼitʰxvɑ");
  });

  it("lowercases detectedLang and trims every field", () => {
    const card = postProcess({
      front: " der  Tisch ",
      back: " стол ",
      transcription: " /tɪʃ/ ",
      example: "Das  Buch liegt auf dem Tisch.",
      exampleTr: " Книга на столе. ",
      pos: "noun",
      detectedLang: "DE",
    });
    expect(card).toEqual({
      front: "der Tisch",
      back: "стол",
      transcription: "tɪʃ",
      example: "Das Buch liegt auf dem Tisch.",
      exampleTr: "Книга на столе.",
      pos: "noun",
      detectedLang: "de",
    });
  });

  it("rejects a reply that is missing a field", () => {
    expect(() => postProcess({ front: "a" })).toThrow();
  });

  it("extracts JSON out of a code fence or prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":1} — enjoy')).toEqual({ a: 1 });
    expect(() => extractJson("no json here")).toThrow();
  });

  it("parses a fenced card end to end", () => {
    const card = parseCard(`\`\`\`json\n${JSON.stringify(kaCard)}\n\`\`\``);
    expect(card.front).toBe("კითხვა");
  });
});

describe("script detection", () => {
  it("accepts Mkhedruli for ka and rejects Latin", () => {
    expect(isInScript("კითხვა", "ka")).toBe(true);
    expect(isInScript("-ში", "ka")).toBe(true);
    expect(isInScript("რა ღირს", "ka")).toBe(true);
    expect(isInScript("gamarjoba", "ka")).toBe(false);
    expect(isInScript("კითხვა (read)", "ka")).toBe(false);
    expect(isInScript("", "ka")).toBe(false);
  });

  it("accepts Latin with accents, apostrophes and hyphens for en/de/es", () => {
    expect(isInScript("der Tisch", "de")).toBe(true);
    expect(isInScript("die Straße", "de")).toBe(true);
    expect(isInScript("rápido", "es")).toBe(true);
    expect(isInScript("look forward to", "en")).toBe(true);
    expect(isInScript("mother-in-law", "en")).toBe(true);
    expect(isInScript("книга", "en")).toBe(false);
  });

  it("recognises Cyrillic exampleTr and rejects a Latin one", () => {
    expect(isMostlyCyrillic("Я читаю книгу.")).toBe(true);
    expect(isMostlyCyrillic("Мы едем в Berlin завтра утром.")).toBe(true);
    expect(isMostlyCyrillic("I am reading a book.")).toBe(false);
    expect(isMostlyCyrillic("")).toBe(false);
  });
});

describe("transcription", () => {
  it("flags slashes and brackets", () => {
    expect(transcriptionIssue("/rʌn/", "en")).toMatch(/slashes/u);
    expect(transcriptionIssue("[rʌn]", "en")).toMatch(/slashes/u);
    expect(transcriptionIssue("rʌn", "en")).toBeNull();
  });

  it("requires the ka letter table for Georgian", () => {
    expect(transcriptionIssue("kʼitʰxvɑ", "ka")).toBeNull();
    expect(transcriptionIssue("t͡sʼqʼɑli", "ka")).toBeNull();
    // "a" and "e" instead of ɑ and ɛ
    expect(transcriptionIssue("kitxva", "ka")).toMatch(/ka IPA table/u);
    expect(transcriptionIssue("", "ka")).toMatch(/empty/u);
  });

  it("keeps the letter table and the allowed characters in sync", () => {
    expect(KA_IPA_CHARS.has("ʼ")).toBe(true);
    expect(KA_IPA_CHARS.has("ʰ")).toBe(true);
    expect(KA_IPA_CHARS.has("a")).toBe(false);
  });
});

describe("example uses front", () => {
  it("matches a literal occurrence", () => {
    expect(exampleUsesFront("water", "I drink water every day.")).toBe(true);
  });

  it("matches an inflected form sharing the first three letters", () => {
    expect(exampleUsesFront("gehen", "Wir gehen nach Hause.")).toBe(true);
    expect(exampleUsesFront("hablar", "Yo hablo español.")).toBe(true);
    expect(exampleUsesFront("კითხვა", "წიგნს ვკითხულობ.")).toBe(true);
  });

  it("ignores the article of a German or Spanish noun", () => {
    expect(exampleUsesFront("der Tisch", "Das Buch liegt auf dem Tisch.")).toBe(true);
    expect(exampleUsesFront("der Tisch", "Das Buch liegt auf dem Boden.")).toBe(false);
  });

  it("strips the hyphen of a Georgian postposition", () => {
    expect(exampleUsesFront("-ში", "სახლში ვარ.")).toBe(true);
  });

  it("fails when the example is about something else", () => {
    expect(exampleUsesFront("water", "I like cats.")).toBe(false);
    expect(exampleUsesFront("water", "")).toBe(false);
  });
});

describe("back matching", () => {
  it("is case- and ё-insensitive and matches stems", () => {
    expect(backIncludesAny("Лёгкий, светлый", ["лёгк"])).toBe(true);
    expect(backIncludesAny("легкий, светлый", ["лёгк"])).toBe(true);
    expect(backIncludesAny("банк, берег", ["скамейка", "берег"])).toBe(true);
    expect(backIncludesAny("стол", ["дом"])).toBe(false);
  });

  it("normalises for comparison", () => {
    expect(normalizeForCompare("  Der   Tisch ")).toBe("der tisch");
  });
});

describe("runChecks", () => {
  it("passes every check on a good Georgian card", () => {
    const results = runChecks(kaCase, kaCard);
    expect(byName(results)).toEqual({
      schema: true,
      front_script: true,
      detected_lang: true,
      front: true,
      pos: true,
      pos_expected: true,
      back: true,
      transcription: true,
      example_uses_front: true,
      example_tr_cyrillic: true,
    });
    expect(passRate(results)).toBe(1);
  });

  it("reports only the schema check when the reply could not be parsed", () => {
    const results = runChecks(kaCase, null, "invalid_output: not JSON");
    expect(results).toEqual([{ name: "schema", pass: false, detail: "invalid_output: not JSON" }]);
  });

  it("reports only the schema check for junk input", () => {
    const junk: EvalCase = {
      id: "ka-junk-asdfgh",
      text: "asdfgh",
      langFrom: "ka",
      langTo: "ru",
      category: "junk",
    };
    const results = runChecks(junk, {
      front: "asdfgh",
      back: "",
      transcription: "",
      example: "",
      exampleTr: "",
      pos: "other",
      detectedLang: "en",
    });
    expect(results).toEqual([{ name: "schema", pass: true }]);
  });

  it("catches a conjugated Georgian front, Latin script and a bad transcription", () => {
    const results = byName(
      runChecks(kaCase, {
        ...kaCard,
        front: "vkitxulob",
        transcription: "vkitxulob",
        exampleTr: "I am reading a book.",
      }),
    );
    expect(results.front_script).toBe(false);
    expect(results.front).toBe(false);
    expect(results.transcription).toBe(false);
    expect(results.example_tr_cyrillic).toBe(false);
    expect(results.schema).toBe(true);
  });

  it("skips checks that the case does not specify", () => {
    const bare: EvalCase = {
      id: "en-plain-water",
      text: "water",
      langFrom: "en",
      langTo: "ru",
      category: "plain",
    };
    const names = runChecks(bare, {
      front: "water",
      back: "вода",
      transcription: "ˈwɔːtər",
      example: "I drink water.",
      exampleTr: "Я пью воду.",
      pos: "noun",
      detectedLang: "en",
    }).map((item) => item.name);
    expect(names).not.toContain("front");
    expect(names).not.toContain("detected_lang");
    expect(names).not.toContain("back");
    expect(names).toContain("pos");
  });

  it("rejects a part of speech outside the allowed list", () => {
    const results = byName(runChecks(kaCase, { ...kaCard, pos: "masdar" }));
    expect(results.pos).toBe(false);
    expect(results.pos_expected).toBe(false);
  });
});
