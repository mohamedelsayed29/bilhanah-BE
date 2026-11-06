import { asTranslations } from './translations.js';

describe('asTranslations', () => {
  it('keeps known languages and non-empty text', () => {
    expect(asTranslations({ fr: { name: 'Koshari', description: '' }, xx: { name: 'nope' }, de: {} })).toEqual({ fr: { name: 'Koshari' } });
  });

  it('treats anything but an object as no translations', () => {
    expect(asTranslations(null)).toEqual({});
    expect(asTranslations([])).toEqual({});
    expect(asTranslations('fr')).toEqual({});
    expect(asTranslations({ fr: 'Koshari' })).toEqual({});
  });
});
