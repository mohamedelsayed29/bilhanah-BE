-- CreateEnum
CREATE TYPE "assistant_handoff" AS ENUM ('NONE', 'COLLECTING');

-- CreateEnum
CREATE TYPE "support_channel" AS ENUM ('FORM', 'CHAT');

-- AlterTable
ALTER TABLE "assistant_sessions" ADD COLUMN     "handoff" "assistant_handoff" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "channel" "support_channel" NOT NULL DEFAULT 'FORM';
