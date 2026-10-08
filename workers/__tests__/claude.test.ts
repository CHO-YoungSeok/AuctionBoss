import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { runClaude } from "../lib/claude";

// SDK 클라이언트를 가짜로 바꿔 네트워크 없이 "API 경로를 탔는가"만 본다.
const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  apiKeys: [] as string[],
}));
vi.mock("@anthropic-ai/sdk", () => {
  class AnthropicError extends Error {}
  class FakeAnthropic {
    static AnthropicError = AnthropicError;
    static APIConnectionTimeoutError = class extends AnthropicError {};
    beta = { messages: { create: sdk.create } };
    constructor(opts: { apiKey: string }) {
      sdk.apiKeys.push(opts.apiKey);
    }
  }
  return { default: FakeAnthropic };
});

describe("runClaude 경로 선택", () => {
  let originalKey: string | undefined;
  let originalBin: string | undefined;
  beforeEach(() => {
    sdk.create.mockReset();
    sdk.apiKeys.length = 0;
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalBin = process.env.AUCTIONBOSS_CLAUDE_BIN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalBin === undefined) delete process.env.AUCTIONBOSS_CLAUDE_BIN;
    else process.env.AUCTIONBOSS_CLAUDE_BIN = originalBin;
  });

  test("ANTHROPIC_API_KEY가 있으면 Messages API(SDK)를 호출하고 CLI는 띄우지 않는다", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    // CLI가 실행되면 실패하도록 존재하지 않는 bin을 지정한다.
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";
    sdk.create.mockResolvedValue({
      content: [{ type: "text", text: "API 경로 결과" }],
      model: "m-api",
      stop_reason: "end_turn",
      stop_details: null,
    });

    const result = await runClaude({ prompt: "p" });

    expect(result).toEqual({ text: "API 경로 결과", model: "m-api" });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.apiKeys).toEqual(["sk-test-key"]);
  });

  test("ANTHROPIC_API_KEY가 없으면 SDK를 부르지 않고 CLI 경로(bin 실행)를 탄다", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";

    // 가짜 bin이라 CLI 실행 실패 오류가 나는 것 자체가 CLI 경로를 탔다는 증거다.
    await expect(runClaude({ prompt: "p" })).rejects.toThrow(/claude CLI 실행 실패/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  test("ANTHROPIC_API_KEY가 빈 문자열이면 CLI 경로를 탄다", async () => {
    process.env.ANTHROPIC_API_KEY = "";
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";

    await expect(runClaude({ prompt: "p" })).rejects.toThrow(/claude CLI 실행 실패/);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
