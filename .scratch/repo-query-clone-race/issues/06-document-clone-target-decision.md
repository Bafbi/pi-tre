# 06: Document the clone-target decision

**What to build:** The durable docs for this work. A glossary for the extension defines Tempspace, Clone target, and Publish. An ADR records the decision to publish clones atomically, the invariant, the cross-process guarantee (one `rename`, no locks), the deferred in-process dedupe, and why that beats batch pre-clone at the message boundary and serial execution. A root context map lists the extension contexts and disambiguates "workspace" (the jj extension's term) from "tempspace" (this extension's).

**Blocked by:** 03, 04

**Status:** done

- [x] The glossary defines Tempspace, Clone target, and Publish, each with an avoid-list.
- [x] The ADR states the atomic-publish decision, the invariant, the cross-process guarantee (one `rename`, no locks), the deferred dedupe, and the rejected alternatives.
- [x] The root context map lists the extension contexts and the workspace/tempspace disambiguation.
- [x] The docs use the same vocabulary as the shipped code and describe the behavior that actually landed.
- [x] The extension check passes.

## Notes

- Ticket 05 landed before this one, so the ADR records in-process dedupe as deferred from the first cut and landed after it, rather than as still deferred.
