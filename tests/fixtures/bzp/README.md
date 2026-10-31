# BZP fixtures

Real responses of the official "API BZP (WebService)" of the e-Zamówienia platform
(`docs/DECISIONS.md` D-015), captured on **2026-10-30** and stored byte for byte as received
(the JSON files are excluded from Prettier for that reason) — **except** personal contact data
inside `htmlBody` values, pseudonymised by a string-level replacement on the raw file text (no
JSON re-serialisation; owner decision, PR #3 review):

- every e-mail address → `kontakt@example.invalid` (including `mailto:` links);
- every phone/fax number → `000 000 000` (labels such as `tel.` kept; NIP/REGON/KRS, postal
  codes, notice numbers, amounts, dates and CPV codes untouched);
- names of natural persons (contact persons, signatories) → `Jan Kowalski`; institution names and
  addresses stay (no such names were present in these captures).

All other fields are unchanged; the data are public notices of the Biuletyn Zamówień
Publicznych. **Rule for future fixtures** (including the PR-03 HTML fixtures): pseudonymise the
same way before committing, keep no unredacted copy in the repository, and record the
substitutions here.

| File                                    | Request                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract-notice-2026-10-29-page1.json` | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=ContractNotice&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=3`                                                               |
| `contract-notice-2026-10-29-page2.json` | same as page 1 plus `&SearchAfter=08df3579-8fb4-7d97-cfcf-e60001c05bd7` (the `objectId` of the last record of page 1)                                                                                                  |
| `small-contract-notice-2026-10-29.json` | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=SmallContractNotice&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=2`                                                          |
| `empty-2026-11-20.json`                 | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?…&PublicationDateFrom=2026-11-20&PublicationDateTo=2026-11-20&…` — a future publication day, no notices published yet; real `[]` response                       |
| `notice-update-notice-2026-10-29.json`  | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=NoticeUpdateNotice&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=5&SearchAfter=08df357b-038d-a049-cfcf-e60001c05bdc` (PR-03B) |
| `province-glossary.json`                | `GET https://ezamowienia.gov.pl/mo-board/api/v1/glossary?glossaryType=province`                                                                                                                                        |

Contents:

- page 1: notices `2026/BZP 00507107/01`, `00507109/01`, `00507112/01`;
- page 2: notices `2026/BZP 00507113/01`, `00507114/01`, `00507115/01`;
- small contracts: `2026/BZP 00507754/01`, `00507787/01` (`cpvCode` `""`, `tenderType` and
  `tenderId` `null`, one `submittingOffersDate` `null`).
- notice updates (`NoticeUpdateNotice`, all with a `tenderId`, `submittingOffersDate` `null`;
  substitutions: 5 e-mail addresses, 3 phone/fax numbers, no names of natural persons):
  - `2026/BZP 00507126/01` — changes a contract notice ("Ogłoszenie o zamówieniu"): 8.1 offer
    deadline (`2026-11-03 10:00` Warsaw → `2026-11-03T09:00:00Z`), plus 8.3 and 8.4;
  - `00507129/01` — changes a contract notice, only section 4.2.2 (no deadline change → skipped);
  - `00507130/01` — 8.1 → `2026-11-04T09:00:00Z`;
  - `00507136/01` — changes an "Ogłoszenie o wykonaniu umowy" (section 5.5) → skipped;
  - `00507141/01` — 8.1 → `2026-11-05T09:00:00Z`.

Since PR-03C (D-022) the `htmlBody` of the contract and small-contract notices above is read
too: description, contact (e-mail/phone of the first contracting authority) and estimated
value come from the form labels "4.2.2.) / 3.3.)", "1.5.7.) / 1.4.7.)", "1.5.9.) / 1.4.9.)",
"4.1.5.) / 3.4.)" and "3.5) Kod waluty" (small contracts). The expected values of every
captured offer are asserted in `tests/bzp-adapter.test.ts`; contact values are only the
substitutes listed above. No new fixture files were added for PR-03C and the substitutions
are unchanged.

Edge cases (missing fields, wrong types, corrupted JSON, …) are built in the tests by mutating a
parsed copy of a real record — never by hand-crafting whole notices. For `htmlBody` (PR-03C,
`tests/bzp-notice-body.test.ts`) the captured bodies are mutated by replacing or removing
form fields, or by appending unclosed markup and hostile repetitions.
