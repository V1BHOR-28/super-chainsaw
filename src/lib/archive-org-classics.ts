/**
 * A small curated list of well-known public-domain classics with pre-verified
 * Internet Archive identifiers and _djvu.txt URLs. Used by "Surprise me" —
 * no live API search needed, every URL was individually verified to return
 * HTTP 200 for its _djvu.txt file.
 *
 * Expand this list over time by searching archive.org/advancedsearch.php,
 * finding the item's identifier, and verifying the _djvu.txt file exists via
 * a HEAD request to https://archive.org/download/{id}/{id}_djvu.txt before
 * adding it here. Don't add entries you haven't personally confirmed.
 *
 * Previously used Project Gutenberg URLs — switched to Archive.org because
 * Gutenberg's website has bot/scraping protections that block datacenter IPs.
 */
export interface CuratedClassic {
  archiveId: string
  title: string
  author: string
  textUrl: string
  tags: string[]
}

export const CURATED_CLASSICS: CuratedClassic[] = [
  { archiveId: 'prideandprejudi02austgoog', title: 'Pride and Prejudice', author: 'Jane Austen', textUrl: 'https://archive.org/download/prideandprejudi02austgoog/prideandprejudi02austgoog_djvu.txt', tags: ['romance', 'social satire', 'British', 'accessible'] },
  { archiveId: 'mobydickorwhale01melvuoft', title: 'Moby Dick; Or, The Whale', author: 'Herman Melville', textUrl: 'https://archive.org/download/mobydickorwhale01melvuoft/mobydickorwhale01melvuoft_djvu.txt', tags: ['adventure', 'philosophical', 'American', 'dense'] },
  { archiveId: 'cu31924105428902', title: 'Frankenstein', author: 'Mary Shelley', textUrl: 'https://archive.org/download/cu31924105428902/cu31924105428902_djvu.txt', tags: ['gothic', 'horror', 'science fiction', 'accessible'] },
  { archiveId: 'cu31924013141985', title: 'Romeo and Juliet', author: 'William Shakespeare', textUrl: 'https://archive.org/download/cu31924013141985/cu31924013141985_djvu.txt', tags: ['tragedy', 'drama', 'short', 'accessible'] },
  { archiveId: 'crimepunishment0018fyod', title: 'Crime and Punishment', author: 'Fyodor Dostoevsky', textUrl: 'https://archive.org/download/crimepunishment0018fyod/crimepunishment0018fyod_djvu.txt', tags: ['philosophical', 'psychological', 'Russian', 'dense'] },
  { archiveId: 'countofmontecris01duma', title: 'The Count of Monte Cristo', author: 'Alexandre Dumas', textUrl: 'https://archive.org/download/countofmontecris01duma/countofmontecris01duma_djvu.txt', tags: ['adventure', 'revenge', 'French', 'long'] },
  { archiveId: 'alicesadventwond00carrrich', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', textUrl: 'https://archive.org/download/alicesadventwond00carrrich/alicesadventwond00carrrich_djvu.txt', tags: ['fantasy', 'whimsical', 'British', 'short', 'accessible'] },
  { archiveId: 'middlemarchstudy12elio_0', title: 'Middlemarch', author: 'George Eliot', textUrl: 'https://archive.org/download/middlemarchstudy12elio_0/middlemarchstudy12elio_0_djvu.txt', tags: ['social', 'British', 'dense', 'long'] },
  { archiveId: 'strangecaseofdrj00stevrich', title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson', textUrl: 'https://archive.org/download/strangecaseofdrj00stevrich/strangecaseofdrj00stevrich_djvu.txt', tags: ['gothic', 'horror', 'psychological', 'short', 'accessible'] },
  { archiveId: 'littlewomenormeg00alcoiala', title: 'Little Women', author: 'Louisa May Alcott', textUrl: 'https://archive.org/download/littlewomenormeg00alcoiala/littlewomenormeg00alcoiala_djvu.txt', tags: ['coming-of-age', 'family', 'American', 'accessible'] },
  { archiveId: 'greatgatsby00fitz_1', title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', textUrl: 'https://archive.org/download/greatgatsby00fitz_1/greatgatsby00fitz_1_djvu.txt', tags: ['American', 'tragedy', 'short', 'accessible'] },
  { archiveId: 'janeeyre00broniala', title: 'Jane Eyre', author: 'Charlotte Brontë', textUrl: 'https://archive.org/download/janeeyre00broniala/janeeyre00broniala_djvu.txt', tags: ['romance', 'gothic', 'coming-of-age', 'British', 'accessible'] },
  { archiveId: 'adventuresofsher00doylrich', title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', textUrl: 'https://archive.org/download/adventuresofsher00doylrich/adventuresofsher00doylrich_djvu.txt', tags: ['mystery', 'detective', 'short stories', 'accessible'] },
  { archiveId: 'dracula00stok', title: 'Dracula', author: 'Bram Stoker', textUrl: 'https://archive.org/download/dracula00stok/dracula00stok_djvu.txt', tags: ['gothic', 'horror', 'epistolary', 'accessible'] },
  { archiveId: 'brotherskaramaz00dost', title: 'The Brothers Karamazov', author: 'Fyodor Dostoevsky', textUrl: 'https://archive.org/download/brotherskaramaz00dost/brotherskaramaz00dost_djvu.txt', tags: ['philosophical', 'religious', 'Russian', 'dense', 'long'] },
  { archiveId: 'adventureshuckle00twaiiala', title: 'Adventures of Huckleberry Finn', author: 'Mark Twain', textUrl: 'https://archive.org/download/adventureshuckle00twaiiala/adventureshuckle00twaiiala_djvu.txt', tags: ['coming-of-age', 'American', 'social commentary', 'accessible'] },
  { archiveId: 'wutheringheights01bron', title: 'Wuthering Heights', author: 'Emily Brontë', textUrl: 'https://archive.org/download/wutheringheights01bron/wutheringheights01bron_djvu.txt', tags: ['gothic', 'romance', 'tragedy', 'British'] },
  { archiveId: 'completeworksofw00shakrich', title: 'The Complete Works of William Shakespeare', author: 'William Shakespeare', textUrl: 'https://archive.org/download/completeworksofw00shakrich/completeworksofw00shakrich_djvu.txt', tags: ['drama', 'poetry', 'British', 'long'] },
  { archiveId: 'historyoftomjone0003fiel', title: 'The History of Tom Jones, a Foundling', author: 'Henry Fielding', textUrl: 'https://archive.org/download/historyoftomjone0003fiel/historyoftomjone0003fiel_djvu.txt', tags: ['comic', 'picaresque', 'British', 'long', 'dense'] },
]
