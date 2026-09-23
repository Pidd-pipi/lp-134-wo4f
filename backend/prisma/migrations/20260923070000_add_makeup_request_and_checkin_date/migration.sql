-- CreateEnum
CREATE TYPE "MakeupRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "checkins" ADD COLUMN "checkDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "checkins" ADD COLUMN "isMakeup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "checkins" ADD COLUMN "makeupReason" TEXT;

-- 历史记录（如有）回填为其创建日期
UPDATE "checkins" SET "checkDate" = DATE_TRUNC('day', "createdAt" AT TIME ZONE 'UTC');

-- CreateTable
CREATE TABLE "makeup_requests" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "checkDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MakeupRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewComment" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pendingKey" TEXT,

    CONSTRAINT "makeup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkins_templateId_memberId_checkDate_key" ON "checkins"("templateId", "memberId", "checkDate");

-- CreateIndex
CREATE UNIQUE INDEX "makeup_requests_pendingKey_key" ON "makeup_requests"("pendingKey");

-- CreateIndex
CREATE INDEX "makeup_requests_groupId_status_idx" ON "makeup_requests"("groupId", "status");

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checkin_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "group_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "support_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
