-- CreateEnum
CREATE TYPE "MakeUpStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable: 打卡记录按自然日唯一（每人每个模板每天一条）
ALTER TABLE "checkins" ADD COLUMN "checkDate" DATE;
ALTER TABLE "checkins" ADD COLUMN "isMakeUp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "checkins" ADD COLUMN "makeUpReason" TEXT;

UPDATE "checkins" SET "checkDate" = ("createdAt" AT TIME ZONE 'Asia/Shanghai')::date
WHERE "checkDate" IS NULL;

-- 历史脏数据去重：同一模板同一成员同一天只保留最早一条
DELETE FROM "checkins" a USING "checkins" b
WHERE a."createdAt" > b."createdAt"
  AND a."templateId" = b."templateId"
  AND a."memberId" = b."memberId"
  AND a."checkDate" = b."checkDate";

ALTER TABLE "checkins" ALTER COLUMN "checkDate" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "checkins_templateId_memberId_checkDate_key" ON "checkins"("templateId", "memberId", "checkDate");

CREATE INDEX "checkins_memberId_checkDate_idx" ON "checkins"("memberId", "checkDate");

-- CreateTable: 补卡申请
CREATE TABLE "makeup_requests" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MakeUpStatus" NOT NULL DEFAULT 'PENDING',
    "reviewComment" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "makeup_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "makeup_requests_templateId_status_idx" ON "makeup_requests"("templateId", "status");

CREATE INDEX "makeup_requests_memberId_checkDate_idx" ON "makeup_requests"("memberId", "checkDate");

-- 同一模板同一成员同一天只允许存在一条待审申请（已批准/已驳回不受此限制）
CREATE UNIQUE INDEX "makeup_requests_pending_template_member_date_key"
ON "makeup_requests"("templateId", "memberId", "checkDate")
WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checkin_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "group_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
