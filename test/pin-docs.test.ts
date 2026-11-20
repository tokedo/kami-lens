// 1.2.0: the documents that state the upstream pin agree with UPSTREAM (also
// asserted by gate G5.d; the check is gates/g5/pin-docs.mts).
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkPinDocs } from '../gates/g5/pin-docs.mts';

describe('the pin in the documents', () => {
  it('every document that states the pin states UPSTREAM\'s', () => {
    const { checks } = checkPinDocs(path.resolve(__dirname, '..'));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
