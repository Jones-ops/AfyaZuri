// A small STARTER set of common outpatient ICD-11 MMS codes with ICD-10 equivalents,
// so diagnosis coding works out of the box and in tests.
//
// For production, load the official WHO linearization instead:
//   1. Download "SimpleTabulation-ICD-11-MMS-en" from https://icd.who.int/browse/latest-release/mms/en
//      (Info → Download → Linearization files).
//   2. npm run icd:import -- path/to/SimpleTabulation-ICD-11-MMS-en.txt
// Verify codes against the WHO browser before relying on this list.

/** @type {Array<[code: string, title: string, chapter: string, icd10: string]>} */
export const ICD11_STARTER = [
  ['1F40', 'Malaria due to Plasmodium falciparum', '01', 'B50'],
  ['1F4Z', 'Malaria, unspecified', '01', 'B54'],
  ['1A00', 'Cholera', '01', 'A00'],
  ['1A07', 'Typhoid fever', '01', 'A01.0'],
  ['1B10', 'Tuberculosis of the respiratory system', '01', 'A15'],
  ['3A00', 'Iron deficiency anaemia', '03', 'D50'],
  ['5A10', 'Type 1 diabetes mellitus', '05', 'E10'],
  ['5A11', 'Type 2 diabetes mellitus', '05', 'E11'],
  ['6A20', 'Schizophrenia', '06', 'F20'],
  ['6A70', 'Single episode depressive disorder', '06', 'F32'],
  ['6A71', 'Recurrent depressive disorder', '06', 'F33'],
  ['8A80', 'Migraine', '08', 'G43'],
  ['8B11', 'Cerebral ischaemic stroke', '08', 'I63'],
  ['BA00', 'Essential hypertension', '11', 'I10'],
  ['BD10', 'Congestive heart failure', '11', 'I50.0'],
  ['CA00', 'Acute nasopharyngitis', '12', 'J00'],
  ['CA01', 'Acute sinusitis', '12', 'J01'],
  ['CA02', 'Acute pharyngitis', '12', 'J02'],
  ['CA23', 'Asthma', '12', 'J45'],
  ['CA40', 'Pneumonia', '12', 'J18'],
  ['GB61', 'Chronic kidney disease', '16', 'N18'],
  ['GC08', 'Urinary tract infection, site not specified', '16', 'N39.0'],
  ['MD12', 'Cough', '21', 'R05'],
  ['MG26', 'Fever of other or unknown origin', '21', 'R50'],
];
