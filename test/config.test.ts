import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://localhost/tganki", BOT_TOKEN: "123:abc" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ PORT: 3000, NODE_ENV: "development", LOG_LEVEL: "info" });
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
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
    const config = loadConfig({ ...base, PUBLIC_URL: "", ANTHROPIC_API_KEY: "" });
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("reports every missing or invalid variable", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: "nope" })).toThrow(/absolute URL/);
  });
});
