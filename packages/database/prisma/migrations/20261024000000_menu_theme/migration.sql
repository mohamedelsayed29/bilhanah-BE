-- The look of each restaurant's public menu (classic, arabesque, ...).
-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "menu_theme" VARCHAR(30) NOT NULL DEFAULT 'classic';

