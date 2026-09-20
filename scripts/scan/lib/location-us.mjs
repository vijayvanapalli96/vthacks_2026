// ---------------------------------------------------------------------------
// location-us.mjs — "is this posting in the United States?", preconfigured.
//
// LIFTED from career-ops v1.33.0 — MIT, (c) 2026 Santiago Fernandez de
// Valderrama. Licence text in ./LICENSE.career-ops. The filter engine below
// (normalizeKeywordList, compileLocationKeyword, compileUsStateAbbrev,
// US_COUNTRY_ALWAYS_ALLOW, USPS_STATES, US_STATE_ALWAYS_ALLOW_MATCHERS,
// locationHintFromUrl, REMOTE_TITLE_RE, REMOTE_NEGATED_RE, titleSignalsRemote,
// buildLocationFilter) is copied from career-ops/scan.mjs, including its
// comments, because every one of those comments records a bug that was paid for
// once already.
//
// WHY COPIED AND NOT IMPORTED: scan.mjs is a 3,600-line CLI. Importing it drags
// in portals.yml, js-yaml, the applications tracker and its lock files. We want
// ~200 lines of string matching, so we take ~200 lines of string matching.
//
// WHAT WAS ADDED HERE (everything below the "HIREWIRE additions" banner):
//   * US_LOCATION_FILTER — the config career-ops would read from portals.yml,
//     written out for the United States and kept in one place.
//   * classifyLocation() — returns { isUs, confidence } instead of a bare
//     boolean, because HIREWIRE stores every posting and makes US-ness a COLUMN.
//     Nothing is discarded, so the filter's verdict has to travel with the row.
//
// WHY THIS LOGIC EXISTS AT ALL: filtering on the string "United States" drops
// "Dublin, OH", because a posting in Ohio does not say "United States"
// anywhere. The 4-tier ladder (block_hard > always_allow > block > allow) plus
// the USPS state table is what makes "Dublin, OH" a US job and "Dublin,
// Ireland" not.
// ---------------------------------------------------------------------------

// ── career-ops/scan.mjs, verbatim ───────────────────────────────────────────
// Location filter semantics, highest precedence first:
//   - `block_hard` matches → reject, and always_allow CANNOT override it
//   - `always_allow` matches → accept (overrides `block`)
//   - `block` matches → reject
//   - `allow` empty → accept
//   - `allow` non-empty → must match at least one keyword, OR the TITLE carries
//     an explicit remote marker (see titleSignalsRemote below)

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

// Compile a location keyword into a word-boundary matcher.
//
// Plain String.includes() is wrong for location keywords because country and
// city names are prefixes of unrelated US place names. The motivating bug:
// blocking "india" also rejected "Indian Head, MD", "Indiana", and
// "Indianapolis" — real US locations, silently dropped from every scan.
// Likewise "china" would swallow "Chinatown" and "uk -" would swallow "Truck -".
//
// Lookarounds rather than \b so keywords that begin or end with punctuation
// (", IND", "UK -") still anchor correctly — \b is defined relative to word
// characters and behaves surprisingly at a punctuation edge.
export function compileLocationKeyword(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWord = /[a-z0-9]/.test(keyword[0]);
  const endsWord = /[a-z0-9]/.test(keyword[keyword.length - 1]);
  const prefix = startsWord ? '(?<![a-z0-9])' : '';
  const suffix = endsWord ? '(?![a-z0-9])' : '';
  const re = new RegExp(`${prefix}${escaped}${suffix}`);
  return (lower) => re.test(lower);
}

function compileLocationKeywordList(value) {
  return normalizeKeywordList(value).map(compileLocationKeyword);
}

// Frozen USPS state-name + abbreviation table. Not a world gazetteer: only
// consulted when always_allow already names the United States as a country,
// so EU-targeted configs (no US token) keep their previous semantics.
export const US_COUNTRY_ALWAYS_ALLOW = new Set(['united states', 'usa', 'u.s.', 'u.s.a.']);
export const USPS_STATES = Object.freeze([
  Object.freeze(['alabama', 'al']),
  Object.freeze(['alaska', 'ak']),
  Object.freeze(['arizona', 'az']),
  Object.freeze(['arkansas', 'ar']),
  Object.freeze(['california', 'ca']),
  Object.freeze(['colorado', 'co']),
  Object.freeze(['connecticut', 'ct']),
  Object.freeze(['delaware', 'de']),
  Object.freeze(['florida', 'fl']),
  Object.freeze(['georgia', 'ga']),
  Object.freeze(['hawaii', 'hi']),
  Object.freeze(['idaho', 'id']),
  Object.freeze(['illinois', 'il']),
  Object.freeze(['indiana', 'in']),
  Object.freeze(['iowa', 'ia']),
  Object.freeze(['kansas', 'ks']),
  Object.freeze(['kentucky', 'ky']),
  Object.freeze(['louisiana', 'la']),
  Object.freeze(['maine', 'me']),
  Object.freeze(['maryland', 'md']),
  Object.freeze(['massachusetts', 'ma']),
  Object.freeze(['michigan', 'mi']),
  Object.freeze(['minnesota', 'mn']),
  Object.freeze(['mississippi', 'ms']),
  Object.freeze(['missouri', 'mo']),
  Object.freeze(['montana', 'mt']),
  Object.freeze(['nebraska', 'ne']),
  Object.freeze(['nevada', 'nv']),
  Object.freeze(['new hampshire', 'nh']),
  Object.freeze(['new jersey', 'nj']),
  Object.freeze(['new mexico', 'nm']),
  Object.freeze(['new york', 'ny']),
  Object.freeze(['north carolina', 'nc']),
  Object.freeze(['north dakota', 'nd']),
  Object.freeze(['ohio', 'oh']),
  Object.freeze(['oklahoma', 'ok']),
  Object.freeze(['oregon', 'or']),
  Object.freeze(['pennsylvania', 'pa']),
  Object.freeze(['rhode island', 'ri']),
  Object.freeze(['south carolina', 'sc']),
  Object.freeze(['south dakota', 'sd']),
  Object.freeze(['tennessee', 'tn']),
  Object.freeze(['texas', 'tx']),
  Object.freeze(['utah', 'ut']),
  Object.freeze(['vermont', 'vt']),
  Object.freeze(['virginia', 'va']),
  Object.freeze(['washington', 'wa']),
  Object.freeze(['west virginia', 'wv']),
  Object.freeze(['wisconsin', 'wi']),
  Object.freeze(['wyoming', 'wy']),
]);

// 2-letter codes: comma-state (", OH" / ",OH, USA") or a trailing token
// ("Dublin OH", Workday URL hint "dublin oh"). Not a generic word-boundary —
// English "in"/"or"/"me" in "Remote, Belgium or France" must not impersonate
// Indiana/Oregon/Maine. State *names* still use compileLocationKeyword.
export function compileUsStateAbbrev(abbr) {
  const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:,\\s*${escaped}(?![a-z0-9])|(?:^|[^a-z0-9])${escaped}[^a-z0-9]*$)`);
  return (lower) => re.test(lower);
}

export const US_STATE_ALWAYS_ALLOW_MATCHERS = USPS_STATES.flatMap(([name, abbr]) => [
  compileLocationKeyword(name),
  compileUsStateAbbrev(abbr),
]);

// Some providers report a rolled-up display string ("5 Locations", "2 Locations")
// while the canonical URL still names the real primary location. Workday is the
// common case: .../job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1 shows
// up as "5 Locations", so no `block` keyword can ever match the location field.
// Recover that signal by reading the path segment right after `/job/`.
//
// Deliberately narrow: only the post-`/job/` segment is inspected, never the whole
// URL. Scanning the full URL would match company slugs and ATS subdomains by
// accident (a "china" or "india" substring inside an unrelated path). Providers
// without the Workday hostname convention yield no hint and keep their previous
// behaviour exactly, even if their own routes also contain `/job/{id}`.
export function locationHintFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (!parsed.hostname.toLowerCase().endsWith('.myworkdayjobs.com')) return '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIdx = segments.lastIndexOf('job');
  if (jobIdx === -1 || jobIdx === segments.length - 1) return '';
  let segment = segments[jobIdx + 1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
  }
  // "Hyderabad-Telangana-India" → "hyderabad telangana india" so multi-word
  // block keywords like "united arab emirates" can still match.
  return segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Some ATSs report the hiring office as the location even when the role is
// remote, and state the remoteness in the TITLE instead: Radancy/TalentBrew
// tenants return bare "City, State" strings, so
//   "Program Manager - Remote"  ->  location "Las Vegas, Nevada"
// An `allow` list written in country/region terms ("united states", "remote")
// then rejects a genuinely remote US role.
//
// Only an unambiguous work-arrangement marker counts. A bare /remote/ test
// would admit domain compounds — "Remote Sensing Program Manager" is an
// on-site GIS role. So "remote" must be followed by end-of-string, a
// non-letter (")", ",", "-"), or " in …" as in "Remote in MO" — never by
// another word, which is what makes "remote sensing" compounds.
export const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;

// …and a negation before the word has to lose, which the marker regex alone
// cannot see: in "Non-Remote" / "Not Remote" the delimiter clears the lookbehind
// and the trailing position clears the lookahead, so an explicitly on-site role
// would bypass a non-empty `allow` list — the exact opposite of the intent.
// `[^a-z]*` matches the marker's breadth, so no punctuation variant (en dash,
// non-breaking hyphen, em dash) can slip between the negation and the word.
// It cannot over-reach, because it never crosses a letter: in "Nonprofit
// Program Manager - Remote" the run after "non" starts with "profit".
export const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

/** @param {unknown} title @returns {boolean} whether the title marks the role remote. */
export function titleSignalsRemote(title) {
  if (typeof title !== 'string' || title.trim() === '') return false;
  const lower = title.toLowerCase();
  if (REMOTE_NEGATED_RE.test(lower)) return false;
  return REMOTE_TITLE_RE.test(lower);
}

// `url` and `title` are optional. Callers that omit them get the original
// location-only semantics.
export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllowKeywords = normalizeKeywordList(locationFilter.always_allow);
  const alwaysAllow = alwaysAllowKeywords.map(compileLocationKeyword);
  // US-targeted configs list the country in always_allow and foreign cities
  // in block. "Dublin, OH" does not contain "United States", so without this
  // expansion block: [Dublin] rejects a real US job. Opt-in on the country
  // token — configs with no US always_allow entry are unchanged.
  if (alwaysAllowKeywords.some(k => US_COUNTRY_ALWAYS_ALLOW.has(k))) {
    alwaysAllow.push(...US_STATE_ALWAYS_ALLOW_MATCHERS);
  }
  const allow = compileLocationKeywordList(locationFilter.allow);
  const block = compileLocationKeywordList(locationFilter.block);
  const blockHard = compileLocationKeywordList(locationFilter.block_hard);

  return (location, url, title) => {
    const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const hint = locationHintFromUrl(url);
    // Nothing to judge on either field → pass (don't penalize missing data).
    if (lower === '' && hint === '') return true;
    const matches = (m) => (lower !== '' && m(lower)) || (hint !== '' && m(hint));
    // `block_hard` is the ONE tier always_allow cannot override. It exists because
    // a European city name can be a whole word inside a non-European location, so
    // word-boundary matching does not catch it and always_allow's unconditional
    // win silently discards the user's own block entry:
    //
    //   "Porto Alegre, Rio Grande do Sul, Brazil"  always_allow "Porto" beats block "Brazil"
    //   "USA - New York - Malta"                   always_allow "Malta" beats block "USA"
    //
    // Plain `block` cannot be promoted wholesale — always_allow exists precisely
    // so a multi-location posting survives one blocked city ("Stockholm · London
    // · Madrid" must not die on a London entry) — so the entries that are
    // country-level, and therefore never a false rejection, are marked here.
    if (blockHard.length > 0 && blockHard.some(matches)) return false;
    // always_allow still wins over block, and may be satisfied by either field:
    // a genuinely US role whose display string says "United States" is never
    // rejected because of what its URL happens to contain.
    if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
    if (block.length > 0 && block.some(matches)) return false;
    if (allow.length === 0) return true;
    if (allow.some(matches)) return true;
    // Last resort only. Deliberately placed AFTER `block` so a remote title can
    // never rescue a blocked location — "Program Manager - Remote" in Bengaluru
    // stays rejected. This widens `allow`, never `block`.
    return titleSignalsRemote(title);
  };
}

// ── HIREWIRE additions ──────────────────────────────────────────────────────

/**
 * The United States preset. In career-ops this lives in the user's portals.yml;
 * here it is a constant because the whole pipeline targets one country.
 *
 * `always_allow` naming the country is what switches on the 50-state +
 * USPS-abbreviation expansion in buildLocationFilter — that is the opt-in, and
 * removing "united states" from this list would silently turn "Dublin, OH" into
 * a non-US posting.
 *
 * `block_hard` is country-level only: a country name in the display string is
 * never a false rejection, so it may outrank the state table. `block` holds
 * non-US CITIES whose names are also US place names — those must stay
 * overridable, which is the entire "Dublin, OH" vs "Dublin, Ireland" case.
 *
 * Not a gazetteer and not trying to be. It is a heuristic over a display string
 * and one URL path segment; §6.3 of docs/JOB_PIPELINE_PLAN.md says so out loud.
 * Because every posting is stored with its verdict in a column, a wrong verdict
 * here is re-examinable rather than lost.
 */
export const US_LOCATION_FILTER = Object.freeze({
  // 'us' is here because these boards write "Remote - US", "Remote US" and
  // "US - Remote" in bulk (300+ rows in the first sweep). Word-boundary matching
  // makes the bare token safe: the lookarounds in compileLocationKeyword mean
  // "Austin", "Houston" and "Columbus" cannot match it. Note that always_allow
  // outranks block, which is correct here — "Remote - US or London" IS a US-open
  // role.
  always_allow: ['united states', 'usa', 'u.s.', 'u.s.a.', 'us'],

  // Country / region names that mean "not in the US", whatever else the string
  // says. Ordered roughly by how often they show up on the seed boards.
  block_hard: [
    'canada', 'mexico', 'brazil', 'brasil', 'argentina', 'chile', 'colombia', 'peru', 'uruguay',
    'costa rica', 'panama', 'guatemala', 'honduras', 'el salvador', 'nicaragua',
    'united kingdom', 'england', 'scotland', 'wales', 'northern ireland', 'ireland',
    'france', 'germany', 'deutschland', 'spain', 'españa', 'portugal', 'italy', 'italia',
    'netherlands', 'holland', 'belgium', 'luxembourg', 'switzerland', 'austria',
    'sweden', 'norway', 'denmark', 'finland', 'iceland', 'estonia', 'latvia', 'lithuania',
    'poland', 'czechia', 'czech republic', 'slovakia', 'hungary', 'romania', 'bulgaria',
    'greece', 'croatia', 'serbia', 'slovenia', 'ukraine', 'türkiye', 'turkey',
    'israel', 'united arab emirates', 'saudi arabia', 'qatar', 'egypt', 'morocco',
    'south africa', 'nigeria', 'kenya', 'ghana',
    'india', 'pakistan', 'bangladesh', 'sri lanka', 'nepal',
    'china', 'hong kong', 'taiwan', 'japan', 'south korea', 'korea',
    'singapore', 'malaysia', 'indonesia', 'thailand', 'vietnam', 'philippines',
    'australia', 'new zealand',
  ],

  // Non-US cities that collide with US place names, or that appear bare (no
  // country) on these boards. Overridable by the state table on purpose.
  block: [
    'dublin', 'london', 'manchester', 'birmingham', 'bristol', 'edinburgh', 'glasgow',
    'belfast', 'cork', 'paris', 'lyon', 'toulouse', 'berlin', 'munich', 'münchen',
    'hamburg', 'frankfurt', 'cologne', 'köln', 'zurich', 'zürich', 'geneva', 'vienna',
    'amsterdam', 'rotterdam', 'utrecht', 'brussels', 'antwerp', 'copenhagen', 'stockholm',
    'oslo', 'helsinki', 'madrid', 'barcelona', 'valencia', 'lisbon', 'porto', 'milan',
    'milano', 'rome', 'roma', 'turin', 'warsaw', 'warszawa', 'krakow', 'kraków', 'prague',
    'praha', 'budapest', 'bucharest', 'sofia', 'athens', 'zagreb', 'belgrade', 'kyiv',
    'kiev', 'istanbul', 'tel aviv', 'dubai', 'abu dhabi', 'riyadh', 'doha', 'cairo',
    'cape town', 'johannesburg', 'lagos', 'nairobi',
    'bengaluru', 'bangalore', 'hyderabad', 'chennai', 'mumbai', 'pune', 'gurgaon',
    'gurugram', 'noida', 'new delhi', 'kolkata', 'ahmedabad', 'karachi', 'lahore',
    'colombo', 'dhaka', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou',
    'taipei', 'tokyo', 'osaka', 'kyoto', 'seoul', 'kuala lumpur', 'jakarta', 'bangkok',
    'hanoi', 'ho chi minh', 'manila', 'cebu', 'sydney', 'melbourne', 'brisbane', 'perth',
    'auckland', 'wellington', 'toronto', 'vancouver', 'montreal', 'montréal', 'calgary',
    'ottawa', 'waterloo', 'mississauga', 'guadalajara', 'monterrey', 'mexico city',
    'são paulo', 'sao paulo', 'rio de janeiro', 'porto alegre', 'belo horizonte',
    'buenos aires', 'santiago', 'bogota', 'bogotá', 'medellin', 'medellín', 'lima',
    'montevideo', 'san josé', 'emea', 'apac', 'latam',
  ],

  // Reached only when nothing above matched. "Remote" with no country attached
  // lands here: it is admitted (these are US employers' own boards) but the
  // caller records location_confidence 'unknown', because no geography was ever
  // read. That is the honest shape — see docs/JOB_PIPELINE_PLAN.md §6.3.
  //
  // US CITIES ARE IN THIS TIER FOR A MEASURED REASON. The first live run stored
  // 834 postings whose location was the bare string "San Francisco" and marked
  // every one of them NOT US: the USPS table matches state names and
  // abbreviations, and a city with no state attached matches nothing in it. Ashby
  // and Greenhouse boards write bare city names constantly. This is precisely the
  // "the US filter is eating everything" failure the plan calls the most likely
  // silent one, and it was caught by querying is_us counts rather than by any
  // error.
  //
  // They sit in `allow` and not `always_allow` so a blocked foreign city still
  // wins: "Birmingham" stays non-US because Birmingham, England is on the block
  // list, while "Birmingham, AL" is rescued by the state table one tier up. Cities
  // whose names are ALSO major non-US cities are deliberately absent here.
  allow: [
    'united states', 'usa', 'u.s.', 'u.s.a.', 'remote', 'anywhere', 'nationwide',
    // Bay Area
    'san francisco', 'sf bay area', 'bay area', 'silicon valley', 'oakland',
    'berkeley', 'palo alto', 'mountain view', 'menlo park', 'sunnyvale',
    'santa clara', 'san mateo', 'redwood city', 'cupertino', 'san jose',
    'south san francisco', 'emeryville', 'fremont',
    // Pacific Northwest
    'seattle', 'bellevue', 'redmond', 'kirkland', 'tacoma', 'spokane', 'portland',
    // SoCal
    'los angeles', 'santa monica', 'culver city', 'pasadena', 'irvine',
    'long beach', 'costa mesa', 'el segundo', 'burbank', 'san diego', 'la jolla',
    // Mountain / Southwest
    'denver', 'boulder', 'colorado springs', 'salt lake city', 'provo', 'lehi',
    'phoenix', 'scottsdale', 'tempe', 'chandler', 'tucson', 'albuquerque',
    'las vegas', 'reno', 'boise',
    // Texas
    'austin', 'dallas', 'houston', 'san antonio', 'fort worth', 'plano', 'irving',
    'el paso',
    // Midwest
    'chicago', 'evanston', 'detroit', 'ann arbor', 'minneapolis', 'saint paul',
    'st. paul', 'madison', 'milwaukee', 'columbus', 'cincinnati', 'cleveland',
    'indianapolis', 'st. louis', 'saint louis', 'kansas city', 'omaha',
    'des moines', 'pittsburgh',
    // Northeast
    'boston', 'cambridge', 'somerville', 'brookline', 'waltham', 'nyc',
    'new york city', 'brooklyn', 'queens', 'manhattan', 'jersey city', 'hoboken',
    'newark', 'princeton', 'stamford', 'hartford', 'new haven', 'providence',
    'philadelphia', 'pittsburgh', 'buffalo', 'rochester', 'albany', 'syracuse',
    'portland maine',
    // Mid-Atlantic / DC metro — the VT catchment
    'washington dc', 'washington, d.c.', 'arlington', 'alexandria', 'mclean',
    'tysons', 'reston', 'herndon', 'vienna va', 'fairfax', 'chantilly',
    'blacksburg', 'roanoke', 'charlottesville', 'richmond va', 'norfolk',
    'virginia beach', 'bethesda', 'rockville', 'silver spring', 'annapolis',
    'baltimore', 'columbia md', 'wilmington',
    // Southeast
    'atlanta', 'savannah', 'charlotte', 'raleigh', 'durham', 'chapel hill',
    'cary', 'research triangle', 'nashville', 'memphis', 'knoxville',
    'huntsville', 'orlando', 'tampa', 'miami', 'jacksonville', 'charleston',
    'new orleans', 'lexington', 'louisville',
    // Other
    'honolulu', 'anchorage',
  ],
});

const isUsLocation = buildLocationFilter(US_LOCATION_FILTER);

// Every matcher that recognises a PLACE, US or not. Used only to answer "did we
// actually read a geography, and from which field?" — never to decide is_us.
// The three work-arrangement words in `allow` are excluded: "Remote" is not a
// place, and letting it count as geography would hide exactly the rows that
// deserve auditing.
const NOT_A_PLACE = new Set(['remote', 'anywhere', 'nationwide']);
const GEO_MATCHERS = [
  ...US_LOCATION_FILTER.always_allow.map(k => compileLocationKeyword(k)),
  ...US_STATE_ALWAYS_ALLOW_MATCHERS,
  ...US_LOCATION_FILTER.block_hard.map(k => compileLocationKeyword(k)),
  ...US_LOCATION_FILTER.block.map(k => compileLocationKeyword(k)),
  ...US_LOCATION_FILTER.allow.filter(k => !NOT_A_PLACE.has(k)).map(k => compileLocationKeyword(k)),
];

/**
 * @typedef {'display'|'url_hint'|'unknown'} LocationConfidence
 *   display  — the posting's own location string named a place we recognise.
 *   url_hint — the location string named no place (e.g. "5 Locations") and the
 *              Workday URL path segment supplied one.
 *   unknown  — no geography was read at all. The is_us verdict rests on a weak
 *              signal (a bare "Remote", a remote title, or an empty location),
 *              so treat these rows as the ones to audit first.
 */

/**
 * Classify a posting's location. Never throws, never discards: both fields of
 * the result are written to job_snapshots as columns.
 *
 * @param {string} location Display string from the provider.
 * @param {string} [url]    Posting URL — supplies the Workday path hint.
 * @param {string} [title]  Posting title — last-resort remote marker.
 * @returns {{ isUs: boolean, confidence: LocationConfidence }}
 */
export function classifyLocation(location, url, title) {
  const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
  const hint = locationHintFromUrl(url);
  let confidence = /** @type {LocationConfidence} */ ('unknown');
  if (lower !== '' && GEO_MATCHERS.some(m => m(lower))) confidence = 'display';
  else if (hint !== '' && GEO_MATCHERS.some(m => m(hint))) confidence = 'url_hint';
  return { isUs: isUsLocation(location, url, title), confidence };
}

export default classifyLocation;
