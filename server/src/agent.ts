import type { Bridge } from "./bridge.js";
import { actionText, addUsage, chooseOption, decide, describe, isSearchField, isTextField, round, type Arrival, type Candidate, type JevUsage } from "./jev.js";
import { pdfHint, tabInfo, type ActAction, type ActResult, type PageElement, type Snapshot, type TabInfo } from "./types.js";

export interface BrowseOptions {
  goal: string;
  tabId?: number;
  maxSteps: number;
  /** Au-dessus de cette confiance Jev, on agit sans vérification. */
  minConfidence: number;
  /**
   * Sous minConfidence, on agit quand même si le Noul de vérification du candidat choisi atteint ce
   * seuil ; sinon on rend la main à Claude. 1 désactive la vérification.
   */
  verifyThreshold: number;
  /** Au-dessus de cette probabilité « objectif atteint », on s'arrête. */
  goalThreshold: number;
  /** Texte à saisir si Jev choisit un champ de recherche ou de saisie. */
  typeText?: string;
  allowRisky: boolean;
}

export type BrowseStatus = "done" | "need_decision" | "max_steps" | "error";

interface Step {
  step: number;
  url: string;
  action: ActAction;
  target: string;
  probability?: number;
  confidence: number;
  /** Noul de vérification, quand la confiance était sous minConfidence. */
  fit?: number;
}

export interface BrowseResult {
  status: BrowseStatus;
  goal: string;
  reason?: string;
  steps: Step[];
  page?: TabInfo;
  goalReachedProbability?: number;
  confidence?: number;
  candidates?: Candidate[];
  hint: string;
  jev: JevUsage;
}

// Libellés d'actions à conséquences : on rend la main à Claude plutôt que de cliquer seul.
// Volontairement large : un faux positif coûte un aller-retour, un faux négatif peut coûter cher.
const RISKY =
  /\b(supprim|delete|remove|effacer|pay|payer|paiement|acheter|buy|purchase|checkout|commander|place order|envoyer|send|publish|publier|unsubscribe|désabonn|désinscri|log ?out|sign ?out|déconnex|transfer|virement|confirm|vote|upvote|downvote|accept|agree|consent|allow|autoris)/i;

// Identifie un élément déjà utilisé sur une page, d'un snapshot à l'autre (les refs changent à chaque snapshot).
const usedKey = (url: string, el: PageElement): string => `${url}|${el.role}|${el.name}`;

const DECISION_HINT =
  "Les refs des candidats restent valables jusqu'au prochain snapshot : utiliser browser_act avec l'un d'eux, " +
  "ou relancer browse_goal avec un objectif plus précis.";

/**
 * Boucle snapshot -> Jev -> action, jusqu'à l'objectif atteint, une décision à confier à Claude,
 * ou le nombre maximal d'étapes.
 */
export async function browseGoal(bridge: Bridge, opts: BrowseOptions): Promise<BrowseResult> {
  const progress: Progress = { steps: [], jev: { calls: 0, inputTokens: 0 } };
  try {
    return await loop(bridge, opts, progress);
  } catch (err) {
    // On garde les étapes déjà faites : Claude sait où en est le navigateur.
    return {
      status: "error",
      goal: opts.goal,
      reason: (err as Error).message,
      ...progress,
      hint: "Vérifier l'état de la page avec browser_status ou browser_snapshot avant de continuer.",
    };
  }
}

type Progress = Pick<BrowseResult, "steps" | "page" | "jev">;

async function loop(bridge: Bridge, opts: BrowseOptions, progress: Progress): Promise<BrowseResult> {
  const { steps, jev } = progress;
  const history: string[] = [];
  const used = new Set<string>();
  let tabId = opts.tabId;
  // Texte encore à saisir : on ne tape qu'une fois par objectif.
  let pendingText = opts.typeText;
  let arrival: Arrival | undefined;
  let lastKey: string | undefined;

  const finish = (status: BrowseStatus, hint: string, extra: Partial<BrowseResult> = {}): BrowseResult => ({
    status,
    goal: opts.goal,
    ...progress,
    hint,
    ...extra,
  });

  for (let step = 1; step <= opts.maxSteps; step++) {
    const snap = await bridge.call<Snapshot>("snapshot", { tabId });
    // On reste sur le même onglet même si l'utilisateur change de focus entre deux étapes.
    tabId = snap.tabId;
    progress.page = tabInfo(snap);
    // Un document ouvert (relevé, facture) est le plus souvent l'objectif : Claude le lit ou l'enregistre.
    if (snap.pdf) return finish("done", pdfHint(snap.pdf));
    if (arrival) {
      const after = snap.elements.find((e) => usedKey(snap.url, e) === lastKey);
      arrival.result = after && describe(after);
    }

    // Un élément déjà utilisé sur cette page n'est plus proposé à Jev : le reproposer ne mènerait qu'à une
    // boucle (retaper dans le même champ, rouvrir le même menu). Jev choisit alors le candidat suivant.
    // Sans texte à saisir, un champ de recherche ne mène nulle part, mais Jev le choisit volontiers
    // (« atteindre l'article X » ressemble à une recherche) : la boucle devrait alors rendre la main.
    const offered = snap.elements.filter(
      (el) => !used.has(usedKey(snap.url, el)) && !(pendingText === undefined && isSearchField(el)),
    );
    const d = await decide(opts.goal, { ...snap, elements: offered }, history, {
      typeText: pendingText,
      verifyBelow: opts.verifyThreshold < 1 ? opts.minConfidence : 0,
      arrival,
    });
    addUsage(jev, d);
    const context = {
      goalReachedProbability: round(d.goalReached),
      confidence: round(d.confidence),
      candidates: d.candidates,
    };
    const handBack = (reason: string) => finish("need_decision", DECISION_HINT, { reason, ...context });

    if (d.goalReached >= opts.goalThreshold) {
      return finish("done", "Lire le contenu avec browser_read pour vérifier et extraire l'information.", {
        goalReachedProbability: context.goalReachedProbability,
      });
    }
    if (!d.choice) {
      return handBack(
        snap.elements.length === 0
          ? "la page ne contient aucun élément interactif et l'objectif ne semble pas atteint"
          : "Jev estime qu'aucun élément de la page ne mène à l'objectif",
      );
    }
    const chosen = d.candidates.find((c) => c.ref === d.choice);
    const verified = chosen?.fit !== undefined && chosen.fit >= opts.verifyThreshold;
    if (d.confidence < opts.minConfidence && !verified) {
      const check = chosen?.fit === undefined ? "" : `, fit de vérification ${chosen.fit} < ${opts.verifyThreshold}`;
      return handBack(`confiance de Jev trop faible (${context.confidence} < ${opts.minConfidence})${check}`);
    }

    const el = snap.elements.find((e) => e.ref === d.choice)!;
    const target = describe(el);
    lastKey = usedKey(snap.url, el);
    used.add(lastKey);
    // Sans libellé (icône de vote, de suppression...), seule l'URL dit ce que fait le lien.
    if (!opts.allowRisky && RISKY.test(el.name || el.href || "")) return handBack(`action potentiellement irréversible : ${target}`);

    const description = chosen?.description ?? target;
    // L'action telle qu'exécutée, pour le contrôle d'arrivée de l'étape suivante.
    let done = actionText(el, description, pendingText);
    let stepTarget = target;
    let act: { action: ActAction; text?: string; submit?: boolean };
    if (el.upload) {
      return handBack(`Jev veut déposer un fichier (${target}) : utiliser browser_upload`);
    }
    if (isTextField(el)) {
      if (pendingText === undefined) {
        return handBack(`Jev veut remplir un champ (${target}) : fournir typeText ou utiliser browser_act`);
      }
      // Entrée seulement dans un champ de recherche : ailleurs elle enverrait un formulaire incomplet.
      act = { action: "type", text: pendingText, submit: el.search === true };
      pendingText = undefined;
    } else if (el.options) {
      const pick = await chooseOption(opts.goal, snap, el);
      addUsage(jev, pick);
      if (pick.option === null || pick.confidence < opts.minConfidence) {
        return handBack(`Jev veut utiliser une liste déroulante (${target}) sans option sûre : choisir la valeur avec browser_act`);
      }
      if (!opts.allowRisky && RISKY.test(pick.option)) {
        return handBack(`option potentiellement irréversible : "${pick.option}" dans ${target}`);
      }
      act = { action: "select", text: pick.option };
      done = `select "${pick.option}" in ${description}`;
      stepTarget = `${target}, option "${pick.option}"`;
    } else {
      act = { action: "click" };
    }
    const result = await bridge.call<ActResult>("act", { tabId, ref: el.ref, ...act });

    progress.page = tabInfo(result);
    steps.push({
      step,
      url: snap.url,
      action: act.action,
      target: stepTarget,
      probability: chosen?.probability,
      confidence: context.confidence,
      fit: chosen?.fit,
    });
    history.push(`${act.action} ${stepTarget} on ${snap.url}`);
    arrival = { page: { url: snap.url, title: snap.title, text: snap.text }, action: done };
  }

  return finish(
    "max_steps",
    "Nombre maximal d'étapes atteint : vérifier la page avec browser_read, puis relancer browse_goal si besoin.",
  );
}
