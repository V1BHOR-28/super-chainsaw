// Audiobook catalog data — matches the ARIA warm-dark, gold aesthetic

export interface Chapter {
  id: string;
  title: string;
  duration: number; // seconds
  summary: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  narrator: string;
  cover: string;
  accent: string; // hex accent for this book's ambient glow
  description: string;
  genres: string[];
  rating: number;
  year: number;
  totalDuration: number; // seconds
  chapters: Chapter[];
  sampleAudio?: string; // optional real audio file for chapter 1
}

export const BOOKS: Book[] = [
  {
    id: "cartographers-daughter",
    title: "The Cartographer's Daughter",
    author: "Elena Marchetti",
    narrator: "James Holloway",
    cover: "/books/book-1.png",
    accent: "#f59e0b",
    description:
      "Twenty years after her father vanished from the harbor of Aveira, Maren receives a letter — and a map that should not exist. A novel about the coordinates of grief, and the charts we draw to find our way home.",
    genres: ["Literary Fiction", "Mystery"],
    rating: 4.8,
    year: 2024,
    totalDuration: 32640,
    sampleAudio: "/audio/sample-chapter.wav",
    chapters: [
      {
        id: "ch-1",
        title: "The Harbor at Dawn",
        duration: 1840,
        summary:
          "Maren watches a ship return to the harbor of Aveira — twenty years after her father sailed from it.",
      },
      {
        id: "ch-2",
        title: "The Letter",
        duration: 2120,
        summary:
          "A sealed envelope, a hand she has not seen in two decades, and a single line: 'Follow the coast.'",
      },
      {
        id: "ch-3",
        title: "Coordinates",
        duration: 1980,
        summary:
          "Maren unfolds her father's last map and finds a coastline that does not exist on any modern chart.",
      },
      {
        id: "ch-4",
        title: "The Lighthouse Keeper",
        duration: 2240,
        summary:
          "On the cliff road north, Maren meets a keeper who claims her father passed through only last spring.",
      },
      {
        id: "ch-5",
        title: "Salt and Silver",
        duration: 2080,
        summary:
          "A storm forces Maren ashore at a village the maps insist is abandoned.",
      },
      {
        id: "ch-6",
        title: "The Second Map",
        duration: 1900,
        summary:
          "Inside her father's sea-chest, a second map — drawn in a hand that is almost, but not quite, her own.",
      },
      {
        id: "ch-7",
        title: "Tide",
        duration: 2360,
        summary:
          "The coast reveals what it has been hiding. Maren must decide whether to follow her father, or turn back.",
      },
      {
        id: "ch-8",
        title: "Homecoming",
        duration: 2120,
        summary:
          "Maren returns to Aveira with a map of her own making.",
      },
    ],
  },
  {
    id: "halflight",
    title: "Halflight",
    author: "Noor Khalil",
    narrator: "Aria Vance",
    cover: "/books/book-2.png",
    accent: "#fbbf24",
    description:
      "Between dusk and full dark there is a country. Saara has walked it every evening since the accident. A quiet novel about the slowness of healing, and the strange mercy of half-remembered light.",
    genres: ["Literary Fiction"],
    rating: 4.6,
    year: 2023,
    totalDuration: 27840,
    chapters: [
      {
        id: "ch-1",
        title: "The Field",
        duration: 1620,
        summary: "Saara walks the golden field at the edge of the town each evening.",
      },
      {
        id: "ch-2",
        title: "What the Doctor Said",
        duration: 1480,
        summary: "Six months. Maybe a year. The words arrive like weather.",
      },
      {
        id: "ch-3",
        title: "Halflight",
        duration: 1720,
        summary: "The hour between dusk and dark, and the things that live there.",
      },
      {
        id: "ch-4",
        title: "The Visitor",
        duration: 1540,
        summary: "Someone is waiting at the edge of the field. They do not speak.",
      },
      {
        id: "ch-5",
        title: "Returning",
        duration: 1680,
        summary: "Saara walks home by a road she does not remember taking.",
      },
      {
        id: "ch-6",
        title: "Full Dark",
        duration: 1820,
        summary: "The first evening Saara does not walk. The field keeps walking without her.",
      },
    ],
  },
  {
    id: "salt-of-distant-seas",
    title: "The Salt of Distant Seas",
    author: "Tomás Reyes",
    narrator: "James Holloway",
    cover: "/books/book-3.svg",
    accent: "#fcd34d",
    description:
      "A journalist boards a container ship to trace the longest trade route on Earth — and finds a floating city of engineers, cooks, mystics, and one quartermaster who has not stepped on land in eleven years.",
    genres: ["Travel", "Narrative Non-fiction"],
    rating: 4.7,
    year: 2024,
    totalDuration: 30240,
    chapters: [
      {
        id: "ch-1",
        title: "Boarding",
        duration: 1740,
        summary: "The harbor of Singapore at midnight, and a ship the size of a city block.",
      },
      {
        id: "ch-2",
        title: "The Quartermaster",
        duration: 1920,
        summary: "Aleksandr has not stepped on land in eleven years. He does not intend to.",
      },
      {
        id: "ch-3",
        title: "Open Water",
        duration: 2080,
        summary: "Three days out, the land disappears. So does the sense of time.",
      },
      {
        id: "ch-4",
        title: "The Cook's Story",
        duration: 1860,
        summary: "In the galley, a cook from Lagos makes food for forty-seven nationalities.",
      },
      {
        id: "ch-5",
        title: "Storm",
        duration: 2240,
        summary: "The sea rises. The ship does not.",
      },
      {
        id: "ch-6",
        title: "Suez",
        duration: 1980,
        summary: "A canal cut through a continent, and the desert on either side.",
      },
      {
        id: "ch-7",
        title: "Landfall",
        duration: 2120,
        summary: "Rotterdam. The end of the longest trade route on Earth.",
      },
    ],
  },
  {
    id: "letters-to-no-one",
    title: "Letters to No One",
    author: "Iris Bellweather",
    narrator: "Aria Vance",
    cover: "/books/book-4.svg",
    accent: "#f59e0b",
    description:
      "An epistolary novel assembled from forty years of unsent letters found in a seaside desk. Each addressed to a different stranger; each, somehow, about the same person.",
    genres: ["Epistolary", "Literary Fiction"],
    rating: 4.9,
    year: 2024,
    totalDuration: 25680,
    chapters: [
      {
        id: "ch-1",
        title: "To the Woman on the Train",
        duration: 1380,
        summary: "A letter begun in 1982, finished in 2019.",
      },
      {
        id: "ch-2",
        title: "To the Lighthouse Keeper",
        duration: 1520,
        summary: "He never answered. She kept writing.",
      },
      {
        id: "ch-3",
        title: "To the Boy Who Sold Newspapers",
        duration: 1440,
        summary: "A street corner in Lisbon. A name she never learned.",
      },
      {
        id: "ch-4",
        title: "To the Astronomer",
        duration: 1620,
        summary: "About a star that went dark the year he was born.",
      },
      {
        id: "ch-5",
        title: "To the Unsent",
        duration: 1780,
        summary: "The final letter. Addressed to no one. About everyone.",
      },
    ],
  },
  {
    id: "lighthouse-worlds-end",
    title: "The Lighthouse at World's End",
    author: "Henrik Sjöberg",
    narrator: "James Holloway",
    cover: "/books/book-5.svg",
    accent: "#fbbf24",
    description:
      "When the keeper of the world's most northerly lighthouse stops transmitting, a young inspector is sent to find out why. What she finds at the edge of the sea is older than the lighthouse, and patient.",
    genres: ["Mystery", "Literary Horror"],
    rating: 4.5,
    year: 2023,
    totalDuration: 33480,
    chapters: [
      {
        id: "ch-1",
        title: "The Light Goes Out",
        duration: 1820,
        summary: "At 03:14 GMT, the beam of the Ultima Thule lighthouse stops turning.",
      },
      {
        id: "ch-2",
        title: "North",
        duration: 2040,
        summary: "Inspector Vey crosses a frozen sea to reach the rock.",
      },
      {
        id: "ch-3",
        title: "The Keeper's Log",
        duration: 1880,
        summary: "The last entry is dated three weeks ago. The keeper is gone.",
      },
      {
        id: "ch-4",
        title: "The Fog",
        duration: 2260,
        summary: "A fog rolls in that does not move like fog.",
      },
      {
        id: "ch-5",
        title: "What the Light Was For",
        duration: 2120,
        summary: "Vey discovers the true purpose of the beam. It was never for ships.",
      },
      {
        id: "ch-6",
        title: "World's End",
        duration: 1980,
        summary: "The light comes back on. Vey does not.",
      },
    ],
  },
  {
    id: "beneath-amber-sky",
    title: "Beneath the Amber Sky",
    author: "Yuki Tanaka",
    narrator: "Aria Vance",
    cover: "/books/book-6.svg",
    accent: "#fcd34d",
    description:
      "On a colony world where the sun never fully sets, a xeno-archaeologist uncovers a city that was old before humanity ever learned to look up. A novel about inheritance, translation, and the long shadow of an amber sun.",
    genres: ["Science Fiction", "Literary"],
    rating: 4.7,
    year: 2024,
    totalDuration: 36120,
    chapters: [
      {
        id: "ch-1",
        title: "The Long Afternoon",
        duration: 1980,
        summary: "On Vesper-9, the sun has not set in four thousand years.",
      },
      {
        id: "ch-2",
        title: "The First Wall",
        duration: 2140,
        summary: "Dr. Imai brushes the sand from a wall that should not be there.",
      },
      {
        id: "ch-3",
        title: "Translation",
        duration: 2020,
        summary: "The glyphs are not a language. They are a warning.",
      },
      {
        id: "ch-4",
        title: "The Inheritors",
        duration: 2280,
        summary: "Someone is still keeping the city. Imai is not sure they are alone.",
      },
      {
        id: "ch-5",
        title: "Dusk",
        duration: 2160,
        summary: "For the first time in four millennia, the sun moves.",
      },
      {
        id: "ch-6",
        title: "Beneath the Amber Sky",
        duration: 2340,
        summary: "Imai makes a choice about what to leave behind, and what to carry.",
      },
    ],
  },
];

export function getBook(id: string): Book | undefined {
  return BOOKS.find((b) => b.id === id);
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
