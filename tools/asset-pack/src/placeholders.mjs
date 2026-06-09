// Minimal valid PNG (1x1, transparent). 67 bytes. Used as a placeholder
// screenshot in the asset pack; replaced by real Playwright captures from
// task 4.4's dry-run recording.
export const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000d49444154789c62000100000500010d0a2db40000000049454e44ae' +
  '426082',
  'hex',
);

// Minimal valid single-page PDF, ~480 bytes, declares "FRTB-SA Deck —
// placeholder". Replaced by the real Reveal.js export from task 4.4 before
// the Tier-1 bank handoff.
export function makePlaceholderPdf(title = 'FRTB-SA Deck — placeholder (replaced by 4.4 dry-run)') {
  const text = title;
  const body = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${44 + text.length} >> stream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream\nendobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ].join('\n');
  const header = body + '\n';
  // Build xref + trailer.
  const offsets = [];
  let pos = 0;
  for (const line of header.split('\n')) {
    if (/^\d+\s+0\s+obj/.test(line)) offsets.push(pos);
    pos += line.length + 1;
  }
  const xrefPos = Buffer.byteLength(header, 'utf8');
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(header + xref + trailer, 'utf8');
}
