# `@marshal/attachments`

Canonical implementation package for Marshal attachment providers and content
conversion. The root entrypoint preserves the existing aggregate API.

New direct consumers should use the focused subpaths:

```ts
import { createAttachmentProvider } from '@marshal/attachments/provider';
import { convertContentToMarkdown } from '@marshal/attachments/content-to-markdown';
```

Both subpaths retain the existing Node-oriented boundaries and host-injected
optional modality services. The legacy package IDs remain compatibility shims
through phase A1b. Phase A1c should migrate imports to these canonical subpaths
before any separately reviewed retirement decision.
