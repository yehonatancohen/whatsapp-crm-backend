-- CreateEnum
CREATE TYPE "WarmupIntensity" AS ENUM ('GHOST', 'LOW', 'NORMAL', 'HIGH');

-- AlterTable
ALTER TABLE "WarmupProgress" ADD COLUMN "warmupIntensity" "WarmupIntensity" NOT NULL DEFAULT 'NORMAL';
