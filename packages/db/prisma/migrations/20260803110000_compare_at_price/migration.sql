-- The shop's own recorded former price (original_price, compare_at_price).
-- Stating it is lawful in some markets and not in others, so it is stored as
-- evidence and the decision to use it is made per post.
ALTER TABLE "Product" ADD COLUMN "compareAtPrice" DECIMAL(14,2);
