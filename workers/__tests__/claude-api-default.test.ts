import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";
import {
  ClaudeInvocationError,
  DEFAULT_API_MODEL,
  runClaudeViaApi,
  type AnthropicLike,
} from "../lib/claude";

type Reply = Record<string, unknown>;

function fakeClient(reply: Reply | Error) {
  const create = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const client = { beta: { messages: { create } } } as unknown as AnthropicLike;
  return { client, create };
}

const ok = (over: Reply = {}): Reply => ({
  content: [{ type: "text", text: "분석 결과" }],
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  stop_details: null,
  ...over,
});

describe("runClaudeViaApi (SDK 주입)", () => {
  test("모델 미지정이면 claude-opus-5-5를 쓴다", async () => {
    const { client, create } = fakeClient(ok());
    await runClaudeViaApi({ prompt: "p" }, "k", client);
    expect(DEFAULT_API_MODEL).toBe("claude-opus-5-5");
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  test("모델을 지정하면 그 값을 쓴다", async () => {
    const { client, create } = fakeClient(ok());
    await runClaudeViaApi({ prompt: "p", model: "claude-sonnet-5-5" }, "k", client);
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  test("요청에 effort, fallbacks, betas, max_tokens, 프롬프트, 타임아웃이 들어간다", async () => {
    const { client, create } = fakeClient(ok());
    await runClaudeViaApi({ prompt: "프롬프트", timeoutMs: 5000 }, "k", client);
    const [body, opts] = create.mock.calls[0] as unknown[];
    expect(body).toMatchObject({
      max_tokens: 16000,
      output_config: { effort: "medium" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      messages: [{ role: "user", content: "프롬프트" }],
    });
    expect(opts).toEqual({ timeout: 5000 });
  });

  test("max_tokens로 끝나면 오류다", async () => {
    const { client } = fakeClient(ok({ stop_reason: "max_tokens" }));
    const err = await runClaudeViaApi({ prompt: "p" }, "k", client).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeInvocationError);
    expect(err.message).toContain("잘림");
  });

  test("refusal로 끝나면 범주를 담은 오류다", async () => {
    const { client } = fakeClient(
      ok({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }),
    );
    const err = await runClaudeViaApi({ prompt: "p" }, "k", client).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeInvocationError);
    expect(err.message).toContain("cyber");
  });

  test("정상 응답은 text 블록을 합치고 실제 응답 모델을 돌려준다", async () => {
    const { client } = fakeClient(
      ok({
        model: "claude-sonnet-5-5",
        content: [
          { type: "thinking", thinking: "생각" },
          { type: "text", text: "가" },
          { type: "text", text: "나" },
        ],
      }),
    );
    const r = await runClaudeViaApi({ prompt: "p" }, "k", client);
    expect(r).toEqual({ text: "가나", model: "claude-sonnet-5-5" });
  });

  test("텍스트가 없으면 오류다", async () => {
    const { client } = fakeClient(ok({ content: [] }));
    await expect(runClaudeViaApi({ prompt: "p" }, "k", client)).rejects.toThrow(ClaudeInvocationError);
  });

  test("SDK 오류는 ClaudeInvocationError로 감싸고 cause를 남긴다", async () => {
    const sdkError = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: "bad key" } },
      "bad key",
      new Headers(),
    );
    const { client } = fakeClient(sdkError);
    const err = await runClaudeViaApi({ prompt: "p" }, "k", client).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeInvocationError);
    expect(err.cause).toBe(sdkError);
  });

  test("SDK 타임아웃 오류도 ClaudeInvocationError다", async () => {
    const { client } = fakeClient(new Anthropic.APIConnectionTimeoutError());
    await expect(runClaudeViaApi({ prompt: "p" }, "k", client)).rejects.toThrow(/끝나지 않아/);
  });
});
