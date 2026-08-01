/**
 * A small curated list of well-known public-domain classics with pre-verified
 * Gutenberg IDs and text/plain URLs. Used by "Surprise me" instead of a live
 * Gutendex search — the free search API is unreliable enough (community-run,
 * no SLA) that gating a user-facing feature on it live, every click, isn't
 * worth it for a list this short and this stable. Public-domain classics
 * don't change; this list doesn't need to be dynamic.
 *
 * Expand this list over time by verifying new entries the same way these
 * were verified — fetch https://gutendex.com/books?search=<title> once,
 * confirm a text/plain format exists, copy the exact URL and id here. Don't
 * add entries you haven't personally confirmed have a working text/plain URL.
 */
export interface CuratedClassic {
  gutenbergId: number
  title: string
  author: string
  textUrl: string
  tags: string[] // loose genre/theme tags, used to help the LLM pick a relevant one
}

export const CURATED_CLASSICS: CuratedClassic[] = [
  { gutenbergId: 1342, title: 'Pride and Prejudice', author: 'Jane Austen', textUrl: 'https://www.gutenberg.org/ebooks/1342.txt.utf-8', tags: ['romance', 'social satire', 'British', 'accessible'] },
  { gutenbergId: 2701, title: 'Moby Dick; Or, The Whale', author: 'Herman Melville', textUrl: 'https://www.gutenberg.org/ebooks/2701.txt.utf-8', tags: ['adventure', 'philosophical', 'American', 'dense'] },
  { gutenbergId: 84, title: 'Frankenstein', author: 'Mary Shelley', textUrl: 'https://www.gutenberg.org/ebooks/84.txt.utf-8', tags: ['gothic', 'horror', 'science fiction', 'accessible'] },
  { gutenbergId: 1513, title: 'Romeo and Juliet', author: 'William Shakespeare', textUrl: 'https://www.gutenberg.org/ebooks/1513.txt.utf-8', tags: ['tragedy', 'drama', 'short', 'accessible'] },
  { gutenbergId: 2554, title: 'Crime and Punishment', author: 'Fyodor Dostoevsky', textUrl: 'https://www.gutenberg.org/ebooks/2554.txt.utf-8', tags: ['philosophical', 'psychological', 'Russian', 'dense'] },
  { gutenbergId: 1184, title: 'The Count of Monte Cristo', author: 'Alexandre Dumas', textUrl: 'https://www.gutenberg.org/ebooks/1184.txt.utf-8', tags: ['adventure', 'revenge', 'French', 'long'] },
  { gutenbergId: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', textUrl: 'https://www.gutenberg.org/ebooks/11.txt.utf-8', tags: ['fantasy', 'whimsical', 'British', 'short', 'accessible'] },
  { gutenbergId: 145, title: 'Middlemarch', author: 'George Eliot', textUrl: 'https://www.gutenberg.org/ebooks/145.txt.utf-8', tags: ['social', 'British', 'dense', 'long'] },
  { gutenbergId: 43, title: 'The Strange Case of Dr. Jekyll and Mr. Hyde', author: 'Robert Louis Stevenson', textUrl: 'https://www.gutenberg.org/ebooks/43.txt.utf-8', tags: ['gothic', 'horror', 'psychological', 'short', 'accessible'] },
  { gutenbergId: 37106, title: 'Little Women', author: 'Louisa May Alcott', textUrl: 'https://www.gutenberg.org/ebooks/37106.txt.utf-8', tags: ['coming-of-age', 'family', 'American', 'accessible'] },
  { gutenbergId: 64317, title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', textUrl: 'https://www.gutenberg.org/ebooks/64317.txt.utf-8', tags: ['American', 'tragedy', 'short', 'accessible'] },
  { gutenbergId: 1260, title: 'Jane Eyre', author: 'Charlotte Brontë', textUrl: 'https://www.gutenberg.org/ebooks/1260.txt.utf-8', tags: ['romance', 'gothic', 'coming-of-age', 'British', 'accessible'] },
  { gutenbergId: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', textUrl: 'https://www.gutenberg.org/ebooks/1661.txt.utf-8', tags: ['mystery', 'detective', 'short stories', 'accessible'] },
  { gutenbergId: 345, title: 'Dracula', author: 'Bram Stoker', textUrl: 'https://www.gutenberg.org/ebooks/345.txt.utf-8', tags: ['gothic', 'horror', 'epistolary', 'accessible'] },
  { gutenbergId: 28054, title: 'The Brothers Karamazov', author: 'Fyodor Dostoevsky', textUrl: 'https://www.gutenberg.org/ebooks/28054.txt.utf-8', tags: ['philosophical', 'religious', 'Russian', 'dense', 'long'] },
  { gutenbergId: 76, title: 'Adventures of Huckleberry Finn', author: 'Mark Twain', textUrl: 'https://www.gutenberg.org/ebooks/76.txt.utf-8', tags: ['coming-of-age', 'American', 'social commentary', 'accessible'] },
  { gutenbergId: 768, title: 'Wuthering Heights', author: 'Emily Brontë', textUrl: 'https://www.gutenberg.org/ebooks/768.txt.utf-8', tags: ['gothic', 'romance', 'tragedy', 'British'] },
  { gutenbergId: 100, title: 'The Complete Works of William Shakespeare', author: 'William Shakespeare', textUrl: 'https://www.gutenberg.org/ebooks/100.txt.utf-8', tags: ['drama', 'poetry', 'British', 'long'] },
  { gutenbergId: 6593, title: 'The History of Tom Jones, a Foundling', author: 'Henry Fielding', textUrl: 'https://www.gutenberg.org/ebooks/6593.txt.utf-8', tags: ['comic', 'picaresque', 'British', 'long', 'dense'] },
]
