# BZP fixtures

Real responses of the official "API BZP (WebService)" of the e-Zamówienia platform
(`docs/DECISIONS.md` D-015), captured on **2026-10-30** and stored **unmodified, byte for byte**
(the JSON files are excluded from Prettier for that reason). The data are public notices of the
Biuletyn Zamówień Publicznych; `htmlBody` contains the full published notice, including the
contact details the buyer published with it — nothing else.

| File                                    | Request                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract-notice-2026-10-29-page1.json` | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=ContractNotice&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=3`                                         |
| `contract-notice-2026-10-29-page2.json` | same as page 1 plus `&SearchAfter=08df3579-8fb4-7d97-cfcf-e60001c05bd7` (the `objectId` of the last record of page 1)                                                                            |
| `small-contract-notice-2026-10-29.json` | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=SmallContractNotice&PublicationDateFrom=2026-10-29&PublicationDateTo=2026-10-29&PageSize=2`                                    |
| `empty-2026-11-20.json`                 | `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?…&PublicationDateFrom=2026-11-20&PublicationDateTo=2026-11-20&…` — a future publication day, no notices published yet; real `[]` response |
| `province-glossary.json`                | `GET https://ezamowienia.gov.pl/mo-board/api/v1/glossary?glossaryType=province`                                                                                                                  |

Contents:

- page 1: notices `2026/BZP 00507107/01`, `00507109/01`, `00507112/01`;
- page 2: notices `2026/BZP 00507113/01`, `00507114/01`, `00507115/01`;
- small contracts: `2026/BZP 00507754/01`, `00507787/01` (`cpvCode` `""`, `tenderType` and
  `tenderId` `null`, one `submittingOffersDate` `null`).

Edge cases (missing fields, wrong types, corrupted JSON, …) are built in the tests by mutating a
parsed copy of a real record — never by hand-crafting whole notices.
