import { describe, expect, it } from "vitest";
import { isLlmEnabled, loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://localhost/tganki", BOT_TOKEN: "123:abc" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ PORT: 3000, NODE_ENV: "development", LOG_LEVEL: "info" });
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("coerces PORT and keeps optional values", () => {
    const config = loadConfig({
      ...base,
      PORT: "8080",
      PUBLIC_URL: "https://tganki.up.railway.app",
    });
    expect(config.PORT).toBe(8080);
    expect(config.PUBLIC_URL).toBe("https://tganki.up.railway.app");
  });

  it("treats empty optional variables as unset", () => {
    const config = loadConfig({ ...base, PUBLIC_URL: "", OPENROUTER_API_KEY: "" });
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("defaults the new bot switches", () => {
    const config = loadConfig(base);
    expect(config.PRO_ENABLED).toBe(false);
    expect(config.ADMIN_TG_IDS).toEqual([]);
    expect(config.WEBHOOK_SECRET).toBeUndefined();
  });

  it("reads PRO_ENABLED as a loose boolean", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(loadConfig({ ...base, PRO_ENABLED: value }).PRO_ENABLED).toBe(true);
    }
    for (const value of ["false", "0", "no", "", "nonsense"]) {
      expect(loadConfig({ ...base, PRO_ENABLED: value }).PRO_ENABLED).toBe(false);
    }
  });

  it("parses the admin id list and drops blanks", () => {
    expect(loadConfig({ ...base, ADMIN_TG_IDS: "123, 456 ,,abc," }).ADMIN_TG_IDS).toEqual([
      123, 456,
    ]);
  });

  it("defaults the LLM layer to off, with the model the eval picked", () => {
    const config = loadConfig(base);
    expect(isLlmEnabled(config)).toBe(false);
    expect(config.LLM_MODEL).toBe("google/gemini-3.7-flash");
    expect(config.LLM_TIMEOUT_MS).toBe(15_000);
    expect(config.LLM_REASONING_EFFORT).toBeUndefined();
    expect(config.LLM_BASE_URL).toBeUndefined();
  });

  it("turns generation on as soon as the OpenRouter key is set", () => {
    const config = loadConfig({
      ...base,
      OPENROUTER_API_KEY: "sk-or-test",
      LLM_MODEL: "openai/gpt-5.6-luna",
      LLM_REASONING_EFFORT: "low",
      LLM_TIMEOUT_MS: "9000",
    });
    expect(isLlmEnabled(config)).toBe(true);
    expect(config.LLM_MODEL).toBe("openai/gpt-5.6-luna");
    expect(config.LLM_REASONING_EFFORT).toBe("low");
    expect(config.LLM_TIMEOUT_MS).toBe(9000);
  });

  it("reports every missing or invalid variable", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: "nope" })).toThrow(/absolute URL/);
  });
});
