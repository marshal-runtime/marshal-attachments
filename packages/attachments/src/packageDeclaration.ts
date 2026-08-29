import type { RuntimePackageDeclaration } from '@marshal/runtime';

export const ATTACHMENTS_PACKAGE_DECLARATION: RuntimePackageDeclaration = {
  packageId: '@marshal/attachments',
  packageVersion: '0.1.0',
  capabilityPrefixes: ['attachments.'],
  skills: [{
    id: 'marshal.attachments/convert',
    title: 'Convert Attachments',
    description: 'Convert bounded files or inline attachment content into Markdown.',
    tags: ['attachments', 'documents', 'markdown'],
    content: [
      '# Marshal Attachments',
      '',
      'Use `attachments.convert` for bounded file, host-handle, or inline attachment conversion.',
      'Respect advertised roots, byte limits, archive limits, and optional modality services.',
      'Treat typed unsupported modality results honestly.',
    ].join('\n'),
  }],
};
