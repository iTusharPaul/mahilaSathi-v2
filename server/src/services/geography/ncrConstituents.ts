/**
 * NCR constituent areas as listed by the National Capital Region Planning Board
 * (https://ncrpb.nic.in/ncrconstituent.html, checked 2026-11-12): whole of NCT Delhi, 14 districts of
 * Haryana, 8 of Uttar Pradesh and 2 of Rajasthan, about 55,083 km² in total.
 *
 * `sourceNames` are the names used in the geometry dataset (geoBoundaries IND ADM2, 2021), which
 * still uses some older district names.
 */

export type StateId = 'delhi' | 'haryana' | 'uttar-pradesh' | 'rajasthan';

export const NCR_STATES: { id: StateId; name: string; code: string; ncrpbAreaKm2: number }[] = [
  { id: 'delhi', name: 'NCT of Delhi', code: 'DL', ncrpbAreaKm2: 1483 },
  { id: 'haryana', name: 'Haryana', code: 'HR', ncrpbAreaKm2: 25327 },
  { id: 'uttar-pradesh', name: 'Uttar Pradesh', code: 'UP', ncrpbAreaKm2: 14826 },
  { id: 'rajasthan', name: 'Rajasthan', code: 'RJ', ncrpbAreaKm2: 13447 },
];

export interface ConstituentDistrict {
  id: string;
  name: string;
  state: StateId;
  sourceNames: string[];
  aliases?: string[];
  /** Official districts whose territory is inside this polygon in the source data. */
  includes?: string[];
}

export const NCR_CONSTITUENT_DISTRICTS: ConstituentDistrict[] = [
  // NCT of Delhi: the whole territory (11 revenue districts in the source data).
  { id: 'dl-central', name: 'Central Delhi', state: 'delhi', sourceNames: ['Central'] },
  { id: 'dl-east', name: 'East Delhi', state: 'delhi', sourceNames: ['East'] },
  { id: 'dl-new-delhi', name: 'New Delhi', state: 'delhi', sourceNames: ['New Delhi'] },
  { id: 'dl-north', name: 'North Delhi', state: 'delhi', sourceNames: ['North'] },
  { id: 'dl-north-east', name: 'North East Delhi', state: 'delhi', sourceNames: ['North East'] },
  { id: 'dl-north-west', name: 'North West Delhi', state: 'delhi', sourceNames: ['North West'] },
  { id: 'dl-shahdara', name: 'Shahdara', state: 'delhi', sourceNames: ['Shahdara'] },
  { id: 'dl-south', name: 'South Delhi', state: 'delhi', sourceNames: ['South'] },
  { id: 'dl-south-east', name: 'South East Delhi', state: 'delhi', sourceNames: ['South East'] },
  { id: 'dl-south-west', name: 'South West Delhi', state: 'delhi', sourceNames: ['South West'] },
  { id: 'dl-west', name: 'West Delhi', state: 'delhi', sourceNames: ['West'] },

  // Haryana (14 districts; Charkhi Dadri is inside the Bhiwani polygon in the source data).
  { id: 'hr-faridabad', name: 'Faridabad', state: 'haryana', sourceNames: ['Faridabad'] },
  { id: 'hr-gurugram', name: 'Gurugram', state: 'haryana', sourceNames: ['Gurgaon'], aliases: ['Gurgaon'] },
  { id: 'hr-nuh', name: 'Nuh', state: 'haryana', sourceNames: ['Mewat'], aliases: ['Mewat'] },
  { id: 'hr-rohtak', name: 'Rohtak', state: 'haryana', sourceNames: ['Rohtak'] },
  { id: 'hr-sonipat', name: 'Sonipat', state: 'haryana', sourceNames: ['Sonipat'], aliases: ['Sonepat'] },
  { id: 'hr-rewari', name: 'Rewari', state: 'haryana', sourceNames: ['Rewari'] },
  { id: 'hr-jhajjar', name: 'Jhajjar', state: 'haryana', sourceNames: ['Jhajjar'], aliases: ['Jhajjhar'] },
  { id: 'hr-panipat', name: 'Panipat', state: 'haryana', sourceNames: ['Panipat'] },
  { id: 'hr-palwal', name: 'Palwal', state: 'haryana', sourceNames: ['Palwal'] },
  {
    id: 'hr-bhiwani',
    name: 'Bhiwani & Charkhi Dadri',
    state: 'haryana',
    sourceNames: ['Bhiwani'],
    aliases: ['Bhiwani', 'Charkhi Dadri'],
    includes: ['Bhiwani', 'Charkhi Dadri'],
  },
  { id: 'hr-mahendragarh', name: 'Mahendragarh', state: 'haryana', sourceNames: ['Mahendragarh'], aliases: ['Narnaul'] },
  { id: 'hr-jind', name: 'Jind', state: 'haryana', sourceNames: ['Jind'] },
  { id: 'hr-karnal', name: 'Karnal', state: 'haryana', sourceNames: ['Karnal'] },

  // Uttar Pradesh (8 districts).
  { id: 'up-meerut', name: 'Meerut', state: 'uttar-pradesh', sourceNames: ['Meerut'] },
  { id: 'up-ghaziabad', name: 'Ghaziabad', state: 'uttar-pradesh', sourceNames: ['Ghaziabad'] },
  {
    id: 'up-gautam-buddh-nagar',
    name: 'Gautam Buddh Nagar',
    state: 'uttar-pradesh',
    sourceNames: ['Gautam Buddha Nagar'],
    aliases: ['Noida', 'Gautam Budh Nagar', 'Gautam Buddha Nagar'],
  },
  { id: 'up-bulandshahr', name: 'Bulandshahr', state: 'uttar-pradesh', sourceNames: ['Bulandshahr'] },
  { id: 'up-baghpat', name: 'Baghpat', state: 'uttar-pradesh', sourceNames: ['Baghpat'] },
  { id: 'up-hapur', name: 'Hapur', state: 'uttar-pradesh', sourceNames: ['Hapur'] },
  { id: 'up-shamli', name: 'Shamli', state: 'uttar-pradesh', sourceNames: ['Samli'], aliases: ['Samli'] },
  { id: 'up-muzaffarnagar', name: 'Muzaffarnagar', state: 'uttar-pradesh', sourceNames: ['Muzaffarnagar'] },

  // Rajasthan (2 districts, as constituted when notified).
  { id: 'rj-alwar', name: 'Alwar', state: 'rajasthan', sourceNames: ['Alwar'] },
  { id: 'rj-bharatpur', name: 'Bharatpur', state: 'rajasthan', sourceNames: ['Bharatpur'] },
];

/** Generous window around NCR used only to disambiguate district names that repeat across India. */
export const NCR_SEARCH_WINDOW = { minLng: 75.3, minLat: 26.6, maxLng: 78.8, maxLat: 30.3 };
