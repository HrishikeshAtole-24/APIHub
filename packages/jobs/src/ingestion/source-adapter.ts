/**
 * Source adapters (Adapter pattern, report 22: "Normalize different source
 * formats — SourceAdapter").
 *
 * The upstream public-apis project publishes its catalogue as a README full of
 * markdown tables, one per category:
 *
 *   ### Animals
 *   API | Description | Auth | HTTPS | CORS
 *   |---|---|---|---|
 *   | [Cat Facts](https://...) | Daily cat facts | No | Yes | No |
 *
 * That is a presentation format, not a data format. This adapter turns it into
 * validated records; everything downstream works with the normalised shape and
 * never sees markdown. Adding another source (an OpenAPI index, a curated JSON
 * file) means writing another adapter, not touching the pipeline.
 */
import { z } from 'zod';

/** Normalised record every adapter must produce. */
export const SourceRecordSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().default(''),
  url: z.string().min(1),
  category: z.string().min(1),
  /** Raw auth string as published upstream, e.g. "apiKey", "OAuth", "No". */
  auth: z.string().default(''),
  https: z.boolean().default(false),
  cors: z.string().default('unknown'),
});

export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export interface SourceAdapter {
  readonly name: string;
  readonly url: string;
  readonly license: string;
  /** Parse raw source content into records. Must not throw on malformed rows. */
  parse(raw: string): { records: SourceRecord[]; failures: { record: string; reason: string }[] };
}

/** Split a markdown table row into cells, tolerating optional outer pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // A naive split on "|" breaks on pipes inside link text, which is rare here
  // but cheap to guard against by ignoring escaped pipes.
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Extract `[text](href)` from a markdown link, or return the raw cell. */
function parseMarkdownLink(cell: string): { text: string; href: string | null } {
  const match = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(cell);
  if (match) return { text: match[1] as string, href: match[2] as string };
  return { text: cell.replace(/[[\]]/g, '').trim(), href: null };
}

/** A markdown separator row such as `|---|:---:|---|`. */
function isSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

export class PublicApisMarkdownAdapter implements SourceAdapter {
  readonly name = 'public-apis';
  readonly license = 'MIT';

  constructor(readonly url: string) {}

  parse(raw: string): { records: SourceRecord[]; failures: { record: string; reason: string }[] } {
    const records: SourceRecord[] = [];
    const failures: { record: string; reason: string }[] = [];

    let currentCategory: string | null = null;
    let inTable = false;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      // Category headings are level-3 in the upstream README.
      const heading = /^###\s+(.+?)\s*$/.exec(trimmed);
      if (heading) {
        currentCategory = (heading[1] as string).replace(/[*_`]/g, '').trim();
        inTable = false;
        continue;
      }

      // A level-1/2 heading ends the catalogue section (e.g. "## License").
      if (/^#{1,2}\s+/.test(trimmed)) {
        currentCategory = null;
        inTable = false;
        continue;
      }

      if (isSeparatorRow(trimmed)) {
        inTable = true;
        continue;
      }

      if (!trimmed.startsWith('|') || currentCategory === null) continue;

      const cells = splitRow(trimmed);

      // The header row itself: mark that a table has started and skip it.
      if (!inTable) {
        if (/^api$/i.test(cells[0] ?? '')) continue;
        continue;
      }

      // Upstream rows are: API | Description | Auth | HTTPS | CORS
      if (cells.length < 5) {
        failures.push({ record: trimmed.slice(0, 120), reason: `expected 5 columns, got ${cells.length}` });
        continue;
      }

      const link = parseMarkdownLink(cells[0] as string);
      if (!link.href) {
        failures.push({ record: trimmed.slice(0, 120), reason: 'no documentation URL' });
        continue;
      }

      const parsed = SourceRecordSchema.safeParse({
        name: link.text,
        description: (cells[1] as string).replace(/[*_`]/g, '').trim(),
        url: link.href,
        category: currentCategory,
        auth: (cells[2] as string).replace(/[`*]/g, '').trim(),
        https: /^yes$/i.test((cells[3] as string).trim()),
        cors: (cells[4] as string).trim().toLowerCase(),
      });

      if (!parsed.success) {
        failures.push({
          record: trimmed.slice(0, 120),
          reason: parsed.error.issues.map((i) => i.message).join('; '),
        });
        continue;
      }

      records.push(parsed.data);
    }

    return { records, failures };
  }
}
