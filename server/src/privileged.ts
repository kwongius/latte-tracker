import { readFile } from "node:fs/promises";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const legacyPhotoPath = "/home/hatch/workspace/ts-spaces/latte-tracker/blobs/objects/97/977cddb9585913a72c636ac175df6eb628727273d396a56512338e0aa120c2e1";

export const privileged = definePrivilegedContracts({
  readLegacyLattePhoto: {
    request: z.object({}),
    response: z.object({
      dataBase64: z.string(),
      mimeType: z.literal("image/jpeg"),
    }),
    timeoutMs: 30000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async readLegacyLattePhoto() {
    const bytes = await readFile(legacyPhotoPath);
    return {
      dataBase64: bytes.toString("base64"),
      mimeType: "image/jpeg" as const,
    };
  },
});
