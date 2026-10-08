import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { runClaude, runClaudeViaApi, ClaudeInvocationError } from "../lib/claude";

describe("runClaudeViaApi", () => {
  test("성공적인 API 호출", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "분석 결과입니다." }],
        model: "claude-3-5-sonnet-20241022",
      }),
    });

    const result = await runClaudeViaApi(
      { prompt: "테스트 프롬프트" },
      "test-api-key",
      mockFetch as unknown as typeof fetch
    );

    expect(result.text).toBe("분석 결과입니다.");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
    
    // Request check
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(callArgs[1].headers["x-api-key"]).toBe("test-api-key");
    const body = JSON.parse(callArgs[1].body);
    expect(body.messages[0].content).toBe("테스트 프롬프트");
  });

  test("API 오류 발생 시 ClaudeInvocationError 예외 발생", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    await expect(
      runClaudeViaApi({ prompt: "테스트" }, "invalid-key", mockFetch as unknown as typeof fetch)
    ).rejects.toThrow(ClaudeInvocationError);
  });

  test("응답에 텍스트가 없는 경우", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [],
      }),
    });

    await expect(
      runClaudeViaApi({ prompt: "테스트" }, "key", mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("Anthropic API 응답에 텍스트가 없습니다");
  });
});

describe("runClaude 경로 선택", () => {
  let originalKey: string | undefined;
  let originalBin: string | undefined;
  beforeEach(() => {
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

  test("ANTHROPIC_API_KEY가 있으면 Messages API(fetch)를 호출하고 CLI는 띄우지 않는다", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    // CLI가 실행되면 실패하도록 존재하지 않는 bin을 지정한다.
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "API 경로 결과" }], model: "m-api" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runClaude({ prompt: "p" });

    expect(result).toEqual({ text: "API 경로 결과", model: "m-api" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("sk-test-key");
  });

  test("ANTHROPIC_API_KEY가 없으면 fetch를 부르지 않고 CLI 경로(bin 실행)를 탄다", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // 가짜 bin이라 CLI 실행 실패 오류가 나는 것 자체가 CLI 경로를 탔다는 증거다.
    await expect(runClaude({ prompt: "p" })).rejects.toThrow(/claude CLI 실행 실패/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("ANTHROPIC_API_KEY가 빈 문자열이면 CLI 경로를 탄다", async () => {
    process.env.ANTHROPIC_API_KEY = "";
    process.env.AUCTIONBOSS_CLAUDE_BIN = "/nonexistent/auctionboss-fake-claude";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runClaude({ prompt: "p" })).rejects.toThrow(/claude CLI 실행 실패/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
