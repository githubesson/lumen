import everywhere from "../assets/covers/everywhere.webp";
import kltSound from "../assets/covers/klt-sound.webp";
import listenToThis from "../assets/covers/listen-to-this.webp";
import loveTattoos from "../assets/covers/love-tattoos.webp";
import nobu from "../assets/covers/nobu.webp";
import ostatniDon from "../assets/covers/ostatni-don.webp";
import vampCity from "../assets/covers/vamp-city.webp";
import wtf from "../assets/covers/wtf.webp";

/** Tracks for the feature demos, matching the library in the hero
 *  screenshots. Covers are cropped from those screenshots. */
export interface Track {
  id: string;
  title: string;
  artist: string;
  cover: string;
}

export const TRACKS: Track[] = [
  { id: "ostatni-don", title: "Ostatni Don", artist: "Młody West", cover: ostatniDon },
  { id: "listen", title: "LISTEN TO THIS IF YOU'RE LOST", artist: "Juice WRLD", cover: listenToThis },
  { id: "nobu", title: "Nobu", artist: "Młody West", cover: nobu },
  { id: "everywhere", title: "Everywhere", artist: "Lil Uzi Vert", cover: everywhere },
  { id: "klt", title: "klt sound", artist: "Młody West", cover: kltSound },
  { id: "love-tattoos", title: "LOVE TATTOOS", artist: "Destroy Lonely", cover: loveTattoos },
  { id: "wtf", title: "WTF", artist: "Młody West", cover: wtf },
];

/** Extra tracks for small spots only: their covers were cropped from a list
 *  view at ~28px, too small for anything bigger than a thumbnail. */
export const SMALL_TRACKS: Track[] = [{ id: "vamp-city", title: "vamp city", artist: "Ken Carson", cover: vampCity }];

export const byId = (id: string) => [...TRACKS, ...SMALL_TRACKS].find((t) => t.id === id)!;

