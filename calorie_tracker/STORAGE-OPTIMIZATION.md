# MacroSync storage optimization

This build preserves the existing user-facing behavior while applying safe storage optimizations.

## Messages

- Message bodies remain lossless text; no lossy compression is used.
- PostgreSQL can automatically TOAST/compress sufficiently large text values.
- Message notification rows no longer duplicate the complete message body. They store a short generic notification and reference the message by `message_id`.
- The existing participant/chronological index is kept intentionally small instead of adding overlapping indexes.
- Base64 is not used as a compression technique because it increases data size.

## Food logs

- USDA records are referenced by `fdc_id` rather than copying the USDA database into Supabase.
- Food-entry nutrition values remain available as a compact historical snapshot so editing a community food cannot rewrite old nutrition history.
- The existing user/date index is retained for efficient diary and history queries.

## Further scale optimization

At very large scale, the next measured optimization should be a migration to a compact meal/log hierarchy and selective lossless compression for unusually large message bodies. That should be benchmarked against real MacroSync data before changing the live storage representation.
