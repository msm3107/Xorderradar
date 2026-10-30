/**
 * BZP `organizationProvince` codes → voivodeship names, as in the official
 * glossary `GET /mo-board/api/v1/glossary?glossaryType=province` (pinned by a
 * test against the captured glossary). A `Map`, so a source value such as
 * `__proto__` can never hit an inherited property. An unknown code has no
 * voivodeship — it is never guessed.
 */
export const bzpProvinces: ReadonlyMap<string, string> = new Map([
  ["PL02", "dolnośląskie"],
  ["PL04", "kujawsko-pomorskie"],
  ["PL06", "lubelskie"],
  ["PL08", "lubuskie"],
  ["PL10", "łódzkie"],
  ["PL12", "małopolskie"],
  ["PL14", "mazowieckie"],
  ["PL16", "opolskie"],
  ["PL18", "podkarpackie"],
  ["PL20", "podlaskie"],
  ["PL22", "pomorskie"],
  ["PL24", "śląskie"],
  ["PL26", "świętokrzyskie"],
  ["PL28", "warmińsko-mazurskie"],
  ["PL30", "wielkopolskie"],
  ["PL32", "zachodniopomorskie"],
]);
