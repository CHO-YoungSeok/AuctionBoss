import { describe, test, expect, vi } from "vitest";
import { runClaudeViaApi, ClaudeInvocationError } from "../lib/claude";

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
