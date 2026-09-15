import { GET } from "../route";
import * as dbModule from "@/lib/db";
import { vi, describe, it, expect, beforeEach, Mock } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

describe("Health Check API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 200 ok when db is connected", async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ "1": 1 }),
      }),
    };
    (dbModule.getDb as Mock).mockReturnValue(mockDb);

    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.database).toBe("connected");
    expect(data.timestamp).toBeDefined();
    expect(data.uptime).toBeDefined();
  });

  it("should return 503 error when db is disconnected", async () => {
    (dbModule.getDb as Mock).mockImplementation(() => {
      throw new Error("DB Connection Error");
    });

    const response = await GET();
    expect(response.status).toBe(503);

    const data = await response.json();
    expect(data.status).toBe("error");
    expect(data.database).toBe("disconnected");
    expect(data.error).toContain("DB Connection Error");
    expect(data.timestamp).toBeDefined();
  });
});
