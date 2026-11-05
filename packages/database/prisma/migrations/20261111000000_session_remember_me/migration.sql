-- "Keep me signed in": true keeps the session for REMEMBER_ME_DAYS, false ends it with the browser.
ALTER TABLE "sessions" ADD COLUMN "remember" BOOLEAN;
