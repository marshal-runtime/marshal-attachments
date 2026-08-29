# @marshal/content-to-markdown

Compatibility package for Marshal attachment content conversion.

The implementation is owned by `@marshal/attachments/content-to-markdown`; this
package preserves the `1.0.0` public API and runtime behavior by re-exporting
that canonical subpath. It retains the existing Node-oriented boundary, has no
harness or Electron dependency, and keeps optional modality services
host-injected.

Existing imports remain supported through phase A1b. Phase A1c should migrate
imports directly:

```ts
import { convertContentToMarkdown } from '@marshal/attachments/content-to-markdown';

const result = await convertContentToMarkdown(
  'notes.txt',
  Buffer.from('attachment content'),
  { mimeType: 'text/plain' },
);
```
