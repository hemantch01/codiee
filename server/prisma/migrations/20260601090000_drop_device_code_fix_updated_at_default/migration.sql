-- Drop the DeviceCode table: the device-authorization flow was removed
-- (CLI uses email/password login; /device returns 410 Gone).
DROP TABLE IF EXISTS "deviceCode";

-- Repair drift with schema.prisma, which declares @default(now()) on this column.
ALTER TABLE "project_chunk" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
