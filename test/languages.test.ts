import { describe, expect, it } from "vitest";
import {
  FEATURED_LANGUAGES,
  findLanguage,
  getLanguage,
  LANGUAGES,
  languageButton,
  languageName,
  languageTag,
} from "../src/i18n/languages.js";

describe("language directory", () => {
  it("has unique codes and covers the featured languages", () => {
    const codes = LANGUAGES.map((lang) => lang.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of FEATURED_LANGUAGES) expect(getLanguage(code)).not.toBeNull();
  });

  it("resolves by code, Russian name, English name and endonym", () => {
    expect(findLanguage("ka")?.code).toBe("ka");
    expect(findLanguage("грузинский")?.code).toBe("ka");
    expect(findLanguage("Georgian")?.code).toBe("ka");
    expect(findLanguage("ქართული")?.code).toBe("ka");
  });

  it("is case- and whitespace-insensitive and tolerates punctuation", () => {
    expect(findLanguage("  ФРАНЦУЗСКИЙ ")?.code).toBe("fr");
    expect(findLanguage("Deutsch")?.code).toBe("de");
    expect(findLanguage("испанский?")?.code).toBe("es");
  });

  it("resolves aliases", () => {
    expect(findLanguage("фарси")?.code).toBe("fa");
    expect(findLanguage("голландский")?.code).toBe("nl");
    expect(findLanguage("латынь")?.code).toBe("la");
  });

  it("returns null for unknown input", () => {
    expect(findLanguage("клингонский")).toBeNull();
    expect(findLanguage("")).toBeNull();
  });

  it("renders names in the UI language and tags for deck titles", () => {
    expect(languageName("en", "ru")).toBe("английский");
    expect(languageName("en", "en")).toBe("English");
    expect(languageName("xx", "ru")).toBe("XX");
    expect(languageButton("de")).toBe("🇩🇪 Deutsch");
    expect(languageTag("en")).toBe("EN");
  });
});
