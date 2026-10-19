// What an importer made of a file. `Brass.registerImporter`'s importer may
// return one, and the platform's own importers write the same shape; it
// reaches readers as `doc.importReport` on the document it describes.
//
// A clean import returns nothing: a report with no findings is not stored.

/** `skipped`: content the file holds that the import did not read.
 *  `assumed`: a value the file did not give, which the import supplied.
 *  `missing`: something the file names that the import did not receive. */
export type ImportFindingKind = 'skipped' | 'assumed' | 'missing';

/** One thing an import skipped, assumed or did not receive. */
export interface ImportFinding {
  kind: ImportFindingKind;
  /** One complete sentence, shown to the reader verbatim. */
  message: string;
}

/** What an importer made of a file. A clean import returns none. */
export interface ImportReport {
  /** One sentence stating what was read, shown above the findings. */
  summary?: string;
  findings: ImportFinding[];
}
