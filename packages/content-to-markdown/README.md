# @marshal/content-to-markdown

Portable Marshal attachment content conversion.

The aggregate `@marshal/attachments` package re-exports this implementation
through its `./content-to-markdown` subpath. It retains the existing Node-
oriented boundary, has no harness or Electron dependency, and keeps optional
modality services host-injected.

```ts
import { convertContentToMarkdown } from '@marshal/content-to-markdown';

const result = await convertContentToMarkdown(
  'notes.txt',
  Buffer.from('attachment content'),
  { mimeType: 'text/plain' },
);
```
