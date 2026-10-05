export interface SummarySentence {
  text: string;
  diffItemIds: string[];
}

export interface CoverageResult {
  covered: boolean;
  missing: string[]; // diff items no sentence references (omission)
  unknownRefs: string[]; // ids sentences reference that are not in the diff (hallucination)
}

// Validates an LLM or release-note summary against the deterministic diff.
// Only the ids are checked; whether the sentence text is accurate is out of scope.
export function checkCoverage(diffItemIds: string[], sentences: SummarySentence[]): CoverageResult {
  const diff = new Set(diffItemIds);
  const referenced = new Set(sentences.flatMap((s) => s.diffItemIds));

  const missing = [...diff].filter((id) => !referenced.has(id));
  const unknownRefs = [...referenced].filter((id) => !diff.has(id));

  return { covered: missing.length === 0 && unknownRefs.length === 0, missing, unknownRefs };
}
