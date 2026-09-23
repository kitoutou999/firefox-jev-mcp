// Formes des données renvoyées par l'extension (voir extension/content.js), et leurs petits helpers.

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  inViewport: boolean;
  /** Destination courte, affichée à Jev (tronquée). */
  href?: string;
  /** URL complète du lien : sert à repérer les doublons, n'est pas envoyée à Jev. */
  url?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  options?: string[];
  checked?: boolean;
  disabled?: boolean;
  /** Champ de recherche : la boucle appuie sur Entrée après la saisie, et seulement dans ce cas. */
  search?: boolean;
  /** aria-expanded (ou <details open> pour un <summary>). */
  expanded?: boolean;
  /** Ce qu'ouvre l'élément d'après aria-haspopup : menu, dialog, listbox... */
  popup?: string;
  zone?: string;
  section?: string;
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
}

export interface Snapshot extends TabInfo {
  elements: PageElement[];
  total: number;
  truncated: boolean;
  text: string;
}

// Garde seulement l'onglet (tabId, url, title) d'un snapshot ou d'un résultat d'action.
export const tabInfo = ({ tabId, url, title }: TabInfo): TabInfo => ({ tabId, url, title });

export const ACT_ACTIONS = ["click", "type", "select"] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];

export interface ActResult extends TabInfo {
  action: ActAction;
  target: string;
  selected?: string;
}
