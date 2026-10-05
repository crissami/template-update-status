import { describe, expect, it } from 'vitest';
import { checkCoverage } from '../src/coverage';

describe('checkCoverage', () => {
  it('reports covered when every diff item is referenced and no unknown ids appear', () => {
    const result = checkCoverage(['d1', 'd2'], [
      { text: 'Added a new risk procedure.', diffItemIds: ['d1'] },
      { text: 'Reworded the opinion letter.', diffItemIds: ['d2'] },
    ]);
    expect(result).toEqual({ covered: true, missing: [], unknownRefs: [] });
  });

  it('lists an unreferenced diff item in missing', () => {
    const result = checkCoverage(['d1', 'd2'], [{ text: 'Added a new risk procedure.', diffItemIds: ['d1'] }]);
    expect(result).toEqual({ covered: false, missing: ['d2'], unknownRefs: [] });
  });

  it('lists a reference to a non-existent id in unknownRefs and reports not covered', () => {
    const result = checkCoverage(['d1'], [{ text: 'Added a procedure and removed a form.', diffItemIds: ['d1', 'd9'] }]);
    expect(result).toEqual({ covered: false, missing: [], unknownRefs: ['d9'] });
  });
});
