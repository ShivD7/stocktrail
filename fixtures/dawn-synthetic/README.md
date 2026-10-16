# Synthetic Dawn diagnostic fixture

These files contain fabricated IDs, SKUs, options, and `.invalid` URLs. They are
offline test data only and were not copied from a store. The markup mirrors the
small product-form seam used by Dawn without vendoring a theme.

Variant `9001` is unavailable in Admin evidence. The broken fixture exposes an
exact variant Offer as `InStock` and an enabled purchase control. The corrected
fixture keeps the same identities while reporting `OutOfStock` and disabling the
control, allowing the same stored regression assertion to pass.
