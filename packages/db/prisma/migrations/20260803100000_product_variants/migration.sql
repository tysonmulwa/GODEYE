-- Sizes, colours and category as the shop records them. These are what let a
-- post answer "will it fit me, does it come in black" without the reader
-- opening the link, and the shop already knows.
ALTER TABLE "Product" ADD COLUMN "variants" JSONB;
