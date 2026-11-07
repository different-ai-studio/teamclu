import { describe, expect, it } from "vitest";
import { attachmentUploadFailureDetail } from "@/lib/attachments/attachment-upload";
import {
  attachmentStorageContentType,
  safeObjectName,
} from "@/lib/attachments/storage-object-key";

describe("safeObjectName", () => {
  it("matches the daemon rules and the live Chinese filenames", () => {
    expect(safeObjectName("诗一首.md")).toBe("file.md");
    expect(safeObjectName("报告 final.pdf")).toBe("final.pdf");
    expect(safeObjectName("report-v2.pdf")).toBe("report-v2.pdf");
    expect(safeObjectName("a_b.c-d.txt")).toBe("a_b.c-d.txt");
    expect(safeObjectName("中文")).toBe("file");
    expect(safeObjectName("AI升级能力地图方案.pdf")).toBe("AI.pdf");
    expect(safeObjectName("物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt")).toBe(
      "-TeamClu-AI_-V0.1.ppt",
    );
  });

  it("is idempotent so client and server rewrites agree", () => {
    for (const name of ["AI升级能力地图方案.pdf", "物流与云仓-TeamClu-AI升级方向方案-V0.1.ppt", "photo.png"]) {
      const once = safeObjectName(name);
      expect(safeObjectName(once)).toBe(once);
    }
  });
});

describe("attachmentStorageContentType", () => {
  it("keeps pdf and falls office documents back to octet-stream", () => {
    expect(attachmentStorageContentType("application/pdf")).toBe("application/pdf");
    expect(attachmentStorageContentType("application/vnd.ms-powerpoint")).toBe(
      "application/octet-stream",
    );
    expect(attachmentStorageContentType("")).toBe("application/octet-stream");
  });
});

describe("attachmentUploadFailureDetail", () => {
  it("surfaces a storage error and drops the generic fallback", () => {
    expect(
      attachmentUploadFailureDetail(
        new Error("Invalid key: team/session/id/AI升级能力地图方案.pdf"),
      ),
    ).toContain("Invalid key");
    expect(attachmentUploadFailureDetail(new Error("Cloud API request failed."))).toBeUndefined();
    expect(attachmentUploadFailureDetail("nope")).toBeUndefined();
  });
});
