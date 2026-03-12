-- Add + prefix to all existing phone numbers that don't have it
UPDATE "Contact" SET "phoneNumber" = '+' || "phoneNumber" WHERE "phoneNumber" NOT LIKE '+%';
