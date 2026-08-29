# Marshal Attachments

`@marshal/attachments-workspace` is an optional Marshal Runtime extension that
contributes `attachments.convert`. It converts bounded files, host-resolved
attachment handles, or inline base64 content into Markdown with metadata,
derived artifacts, typed errors, provenance, and an execution receipt.

The repository also contains the reusable `@marshal/attachments` conversion
library and compatibility packages.

## Supported content

| Input | Built-in behavior | Optional host support |
| --- | --- | --- |
| Text, code, config, HTML, XHTML, SVG | Readable Markdown | None |
| DOCX, XLS/XLSX, PPTX, EPUB | Text and document structure | Embedded-image analysis |
| PDF | Text and document metadata | OCR for sparse or scanned pages |
| ZIP | Supported entries within configured bounds | Services used by nested files |
| Audio and video | Available metadata | Transcription and semantic analysis |

Standalone raster images are not currently converted.

## Requirements

- Node.js 24.14 or newer
- pnpm 10.32.1

The pinned first-party dependencies are not yet available from the configured
public registry. A normal registry-backed consumer install remains unavailable
until that dependency closure is published.

## Build and install in Marshal

For a Marshal Runtime source checkout, place this repository at:

```text
<marshal-agent-runtime>\extensions\<repository>
```

With the pinned first-party dependencies available, build the workspace and
root extension:

```powershell
pnpm install
pnpm build
```

The root entrypoint is `dist\extension.cjs`. Open **Marshal > Plugins**, refresh
the Runtime catalog, find `@marshal/attachments-workspace`, then explicitly
**Install** and **Enable** it.

Discovery only publishes a catalog candidate. It does not install, enable,
activate, or execute the extension. Packaged Marshal installations use the
extension location managed by the Plugins host.

Release-candidate validation can resolve reviewed package archives from an
external directory:

```powershell
$env:MARSHAL_CANDIDATE_DIR = "C:\absolute\path\to\candidates"
pnpm verify:with-candidates
```

## Use

Invoke `attachments.convert` with an absolute file path under an allowed root:

```json
{
  "filePath": "C:\\work\\project\\notes.txt",
  "mimeType": "text/plain"
}
```

Inputs may instead use `attachmentHandle`, or `contentBase64` with `filePath`
as its source label. Handles require the optional host resolver. File paths
must resolve to regular files; linked paths, denied roots, and root escapes are
rejected.

## Configuration

The Runtime extension accepts:

| Field | Purpose |
| --- | --- |
| `allowedRoots` | Roots from which path inputs may be read |
| `deniedRoots` | Roots that remain blocked even when otherwise allowed |
| `artifactDirectory` | Derived-artifact output directory |
| `artifactDirectoryRoot` | Required containment root for artifacts |
| `maxInputBytes` | Input limit; default 64 MiB |
| `maxArchiveEntries` | ZIP entry limit; default 50 |
| `maxArchiveDepth` | ZIP nesting limit; default 3 |

Root omission and an explicit empty array are intentionally different:

- With host context, omitted roots default to the workspace for
  `allowedRoots`, the Runtime state root for `deniedRoots`, and
  `stateRoot\attachment-artifacts` for derived artifacts.
- Explicit `allowedRoots: []` disables path reads.
- Explicit root arrays are authoritative, including `deniedRoots: []`.
- Without host context, omitted allowed roots remain fail-closed.

Inline base64 conversion remains available when path reads are disabled.
Marshal Plugins exposes the current configuration as JSON after installation.

The optional live service `Symbol.for("@marshal/attachments:host")` can resolve
attachment handles and provide image, document-image, audio, and video analysis
services. The extension looks up this service for each invocation.

## Optional tools and limitations

- Sparse/scanned PDF OCR requires a document-image service and either
  `pdftoppm` or ImageMagick `magick`.
- `ffprobe` provides richer audio/video metadata; metadata conversion still
  works without it.
- PPTX conversion extracts structure rather than exact layout or animation.
- Archive conversion supports ZIP only.
- The root extension is a private bundled payload, not a registry package.

## License

[MIT](LICENSE)
