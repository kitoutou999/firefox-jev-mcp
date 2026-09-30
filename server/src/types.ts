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
  /** Champ fichier, ou élément relié à un champ fichier (label, bouton qui le contient) : voir browser_upload. */
  upload?: boolean;
  /** Nom de l'iframe qui contient l'élément. */
  frame?: string;
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
  /** Indicateur de chargement encore visible au bout du délai d'attente. */
  loading?: string;
  /** L'onglet affiche ce PDF dans la visionneuse de Firefox : aucun élément. */
  pdf?: string;
}

// Consigne donnée à Claude quand l'onglet affiche un PDF.
export const pdfHint = (name: string): string =>
  `L'onglet affiche le PDF « ${name} » : browser_read donne son texte, browser_save l'enregistre.`;

/** Fichier renvoyé par l'extension, contenu en base64. */
export interface FilePayload {
  url: string;
  name: string;
  type: string;
  size: number;
  data: string;
}

/** Texte de la page, ou le PDF affiché dans l'onglet (la visionneuse de Firefox est fermée aux extensions). */
export interface ReadResult extends TabInfo {
  text?: string;
  loading?: string;
  pdf?: FilePayload;
}

// Garde seulement l'onglet (tabId, url, title) d'un snapshot ou d'un résultat d'action.
export const tabInfo = ({ tabId, url, title }: TabInfo): TabInfo => ({ tabId, url, title });

export const ACT_ACTIONS = ["click", "type", "select"] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];

export interface UploadResult extends TabInfo {
  action: "upload";
  target: string;
  files: string[];
  /** input : fichiers affectés au champ ; drop : glisser-déposer simulé sur l'élément. */
  via: "input" | "drop";
  accept?: string;
}

export interface ActResult extends TabInfo {
  action: ActAction;
  target: string;
  selected?: string;
  /** type dans un éditeur riche : le texte n'apparaît pas dans le champ après la saisie. */
  warning?: string;
}
