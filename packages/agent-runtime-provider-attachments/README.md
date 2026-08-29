# `@marshal/agent-runtime-provider-attachments`

Compatibility package for the bounded Marshal attachment provider.

The implementation is owned by `@marshal/attachments/provider`; this package
preserves the `0.1.0` public API and runtime behavior by re-exporting that
canonical subpath. Existing imports remain supported through phase A1b.
Phase A1c should migrate imports directly:

```ts
import { createAttachmentProvider } from '@marshal/attachments/provider';
```
