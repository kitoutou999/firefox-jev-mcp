import { TypeSafeClient, choice, noul, type ChoiceCriteria, type Question, type ResultFor, type Usage } from "@typesafe-ai/sdk";
import { log } from "./log.js";
import type { PageElement, Snapshot } from "./types.js";

// Option ajoutée à chaque Choice pour que Jev puisse dire qu'aucun élément ne convient.
const NONE = "none_of_these";
// L'API accepte 255 options par Choice : on garde de la marge pour NONE.
const MAX_OPTIONS = 250;
const CHUNK_SIZE = 200;
const KEEP_PER_CHUNK = 5;
// L'API refuse une requête de plus de 64k tokens : on regroupe les tranches sous ce budget estimé.
const REQUEST_BUDGET = 40_000;
// Estimation prudente (environ 4 caractères par token en anglais, 3 pour garder de la marge).
const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 3);

// Candidats relus par un Noul quand le Choice hésite.
const VERIFY_TOP = 3;

export interface Candidate {
  ref: string;
  probability: number;
  /** Noul « cette action fait-elle avancer vers l'objectif ? », présent seulement après vérification. */
  fit?: number;
  description: string;
}

/** Consommation de l'API Jev. */
export interface JevUsage {
  calls: number;
  inputTokens: number;
}

export function addUsage(total: JevUsage, part: JevUsage): void {
  total.calls += part.calls;
  total.inputTokens += part.inputTokens;
}

export interface Decision extends JevUsage {
  /** ref choisi, ou null si Jev préfère NONE. */
  choice: string | null;
  confidence: number;
  /** Probabilité que l'objectif soit atteint : d'après la page seule, ou la page précédente et l'action faite. */
  goalReached: number;
  candidates: Candidate[];
}

/** L'étape précédente : la page où l'action a eu lieu et l'action elle-même. */
export interface Arrival {
  page: { url: string; title: string; text: string };
  action: string;
  /** L'élément après l'action (valeur d'une liste, d'un champ), s'il est encore sur la page. */
  result?: string;
}

export interface DecideOptions {
  /** Texte que la boucle peut taper : Jev doit le savoir pour préférer un champ de recherche. */
  typeText?: string;
  /** En dessous de cette confiance, un second appel vérifie les meilleurs candidats un par un. */
  verifyBelow?: number;
  /** Étape précédente, pour vérifier l'arrivée sur une cible définie par la page de départ. */
  arrival?: Arrival;
}

const stderrLogger = { debug: log, info: log, warn: log, error: log };

let client: TypeSafeClient | undefined;

export const hasJevKey = (): boolean => Boolean(process.env.TYPESAFE_API_KEY);

function getClient(): TypeSafeClient {
  if (!hasJevKey()) throw new Error("TYPESAFE_API_KEY absente : la renseigner dans firefox-jev-mcp/.env");
  client ??= new TypeSafeClient({ logger: stderrLogger, timeout: 20_000 });
  return client;
}

// Description compacte d'un élément, lue par Jev comme par Claude.
export function describe(el: PageElement): string {
  const parts = [`${el.role} "${el.name || "(no label)"}"`];
  if (el.type && !["text", "submit", "button"].includes(el.type)) parts.push(`type ${el.type}`);
  if (el.search && el.type !== "search" && el.role !== "searchbox") parts.push("search field");
  if (el.placeholder && el.placeholder !== el.name) parts.push(`placeholder "${el.placeholder}"`);
  if (el.value) parts.push(`value "${el.value}"`);
  if (el.options) parts.push(`options: ${el.options.join(" | ")}`);
  if (el.href) parts.push(`to ${el.href}`);
  if (el.section) parts.push(`under "${el.section}"`);
  if (el.zone) parts.push(`in ${el.zone}`);
  if (el.checked !== undefined) parts.push(el.checked ? "checked" : "unchecked");
  if (el.popup) parts.push(`opens a ${el.popup}`);
  if (el.expanded !== undefined) parts.push(el.expanded ? "expanded" : "collapsed");
  if (!el.inViewport) parts.push("offscreen");
  return parts.join(", ");
}

// Une option du Choice : un élément, plus les autres libellés des liens qui mènent à la même URL.
interface Option {
  el: PageElement;
  aliases: string[];
}

// Clé de fusion d'un lien : son URL complète, sauf s'il pointe vers la page courante (href="#", ancre),
// cas où il déclenche souvent un JavaScript propre à chaque lien.
function targetKey(el: PageElement, pageUrl: string): string | undefined {
  if (!el.href || !el.url) return undefined;
  try {
    const target = new URL(el.url);
    const page = new URL(pageUrl);
    target.hash = page.hash = "";
    return target.href === page.href ? undefined : el.url;
  } catch {
    return undefined;
  }
}

/**
 * Fusionne les liens qui mènent à la même URL (menu, carte, pied de page...) : cliquer l'un ou l'autre
 * revient au même. Sans cela, Jev répartit sa probabilité entre les doublons et sa confiance baisse
 * alors qu'il n'hésite pas sur la destination.
 */
function mergeSameTarget(elements: PageElement[], pageUrl: string): Option[] {
  const options: Option[] = [];
  const byTarget = new Map<string, Option>();
  for (const el of elements) {
    const key = targetKey(el, pageUrl);
    const same = key ? byTarget.get(key) : undefined;
    if (!same) {
      const option = { el, aliases: [] };
      options.push(option);
      if (key) byTarget.set(key, option);
      continue;
    }
    const names = [same.el.name, ...same.aliases, el.name];
    // On clique de préférence un exemplaire visible à l'écran.
    if (el.inViewport && !same.el.inViewport) same.el = el;
    same.aliases = [...new Set(names)].filter((n) => n && n !== same.el.name).slice(0, 3);
  }
  return options;
}

function describeOption({ el, aliases }: Option): string {
  const base = describe(el);
  return aliases.length ? `${base}, also labeled ${aliases.map((a) => `"${a}"`).join(", ")}` : base;
}

function criteriaFor(options: Option[]): ChoiceCriteria {
  const criteria: ChoiceCriteria = {};
  for (const option of options) criteria[option.el.ref] = describeOption(option);
  criteria[NONE] = "None of the listed elements helps to reach the goal";
  return criteria;
}

export const isTextField = (el: PageElement): boolean =>
  el.role === "textbox" || el.role === "searchbox" || (el.role === "combobox" && !el.options);

export const isSearchField = (el: PageElement): boolean => isTextField(el) && (el.search === true || el.role === "searchbox");

// L'action telle que la boucle l'exécute, formulée littéralement pour les Nouls de vérification et d'arrivée.
export function actionText(el: PageElement, description: string, typeText: string | undefined): string {
  if (isTextField(el) && typeText !== undefined) {
    return `type "${typeText}" into ${description}${el.search ? ", then press Enter" : ""}`;
  }
  return `click ${description}`;
}

function ranked(probabilities: Readonly<Record<string, number>>, keep: number): [string, number][] {
  return Object.entries(probabilities)
    .filter(([ref]) => ref !== NONE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, keep);
}

// Réponse à une question d'un ensemble construit dynamiquement (tranches, vérifications) : le SDK n'en
// connaît que l'union, d'où ces gardes. Pour un ensemble littéral, il infère le type exact.
type Answer = ResultFor<Question>;

function asChoice(answer: Answer) {
  if (answer.type !== "choice") throw new Error(`Réponse Jev inattendue : ${answer.type} au lieu de choice`);
  return answer;
}

function asNoul(answer: Answer) {
  if (answer.type !== "noul") throw new Error(`Réponse Jev inattendue : ${answer.type} au lieu de noul`);
  return answer.noul;
}

/**
 * Noul « arrivée » : la page courante satisfait-elle l'objectif, vu la page précédente et l'action faite ?
 * Couvre les objectifs définis par la page de départ (« la 3e histoire », « le livre le moins cher ») :
 * la page d'arrivée seule ne dit ni le rang ni le prix relatif.
 */
function checkArrival(ts: TypeSafeClient, goal: string, snap: Snapshot, arrival: Arrival) {
  return ts.systemOne({
    state: {
      goal,
      previous_page: { url: arrival.page.url, title: arrival.page.title, text_start: arrival.page.text },
      action_taken: arrival.action,
      // Le texte de la page ne montre pas la valeur d'une liste ou d'un champ : on la donne à part.
      ...(arrival.result && { element_after_action: arrival.result }),
      current_page: { url: snap.url, title: snap.title, text_start: snap.text },
    },
    questions: {
      arrived: noul(
        { question: "Does the current page satisfy the goal, given the previous page and the action taken on it?", goal },
        {
          true: "On the previous page, the action opened exactly what the goal asks for, and the current page shows it",
          false: "The action opened something else, or more navigation is still needed",
        },
      ),
    },
  });
}

/**
 * Demande à Jev quel élément utiliser pour avancer vers l'objectif, en deux temps :
 * 1. Un Choice classe les éléments (liens vers une même URL fusionnés) et, dans la même requête,
 *    un Noul dit si la page satisfait déjà l'objectif.
 * 2. Si la confiance du Choice est sous `verifyBelow`, un second appel pose un Noul par candidat parmi
 *    les premiers. Le Choice est relatif : quand plusieurs chemins mènent au but (recherche, menu, lien
 *    direct), il partage la probabilité entre eux. Le Noul est absolu : il peut être haut pour plusieurs
 *    candidats à la fois, et bas pour tous quand aucun ne convient.
 * Après une action, un Noul « arrivée » part en parallèle : l'objectif est atteint si la page seule ou ce
 * contrôle le dit.
 * Au-delà de 250 options, le Choice se fait en deux passes : un Choice par tranche de 200 dans une seule
 * requête, puis un Choice final sur les meilleurs candidats de chaque tranche.
 * Les consignes sont en anglais, la langue principale de Jev.
 */
export async function decide(goal: string, snap: Snapshot, history: string[], opts: DecideOptions = {}): Promise<Decision> {
  const ts = getClient();
  const { typeText, verifyBelow = 0 } = opts;
  const options = mergeSameTarget(snap.elements.filter((el) => !el.disabled), snap.url);
  const byRef = new Map(options.map((option) => [option.el.ref, option]));

  const state = {
    goal,
    page: { url: snap.url, title: snap.title },
    previous_steps: history.slice(-5),
    ...(typeText !== undefined && { text_to_type: typeText }),
    page_text_start: snap.text,
  };
  const instructions = {
    question: "Which element should be clicked or used next to make progress toward the goal?",
    goal,
    ...(typeText !== undefined && { note: "Typing text_to_type into a search or text field is an available action." }),
  };
  const goalQuestion = noul(`Does the current page already satisfy this goal: "${goal}"?`, {
    true: "The page itself already shows what the goal asks for; no more navigation is needed",
    false: "More navigation or interaction is still needed",
  });

  let pool = options;
  let goalReached: number | undefined;
  const usage: JevUsage = { calls: 0, inputTokens: 0 };
  const tally = <R extends { usage: Usage }>(res: R): R => {
    addUsage(usage, { calls: 1, inputTokens: res.usage.input_tokens });
    return res;
  };

  // En parallèle de la décision, pour ne pas rallonger l'étape.
  const arrivalCheck = opts.arrival && checkArrival(ts, goal, snap, opts.arrival);
  // Évite un rejet non géré si la décision échoue avant qu'on attende ce contrôle ; await le relance.
  arrivalCheck?.catch(() => undefined);
  const withArrival = async (pageCheck: number): Promise<number> => {
    if (!arrivalCheck) return pageCheck;
    return Math.max(pageCheck, tally(await arrivalCheck).answers.arrived.noul);
  };

  // Une page sans élément interactif (page de résultats, article...) peut très bien satisfaire l'objectif.
  if (options.length === 0) {
    const res = tally(await ts.systemOne({ state, questions: { goal_reached: goalQuestion } }));
    goalReached = await withArrival(res.answers.goal_reached.noul);
    return { choice: null, confidence: 0, goalReached, candidates: [], ...usage };
  }

  if (options.length > MAX_OPTIONS) {
    const chunks: Option[][] = [];
    for (let i = 0; i < options.length; i += CHUNK_SIZE) chunks.push(options.slice(i, i + CHUNK_SIZE));
    // Une requête par groupe de tranches tenant dans le budget, envoyées en parallèle.
    const batches: Record<string, Question>[] = [{ goal_reached: goalQuestion }];
    let size = estimateTokens(state) + estimateTokens(goalQuestion);
    chunks.forEach((chunk, i) => {
      const question = choice(instructions, criteriaFor(chunk));
      const cost = estimateTokens(question);
      if (size + cost > REQUEST_BUDGET && Object.keys(batches.at(-1)!).length > 0) {
        batches.push({});
        size = estimateTokens(state);
      }
      batches.at(-1)![`chunk_${i}`] = question;
      size += cost;
    });
    const results = await Promise.all(batches.map((questions) => ts.systemOne({ state, questions })));
    const answers: Record<string, Answer> = {};
    for (const res of results) Object.assign(answers, tally(res).answers);
    goalReached = asNoul(answers.goal_reached);
    pool = chunks.flatMap((_, i) =>
      ranked(asChoice(answers[`chunk_${i}`]).probabilities, KEEP_PER_CHUNK).map(([ref]) => byRef.get(ref)!),
    );
    log(`passe 1 : ${options.length} options, ${chunks.length} tranches en ${batches.length} requêtes, ${pool.length} candidats retenus`);
  }

  const questions: Record<string, Question> = { next: choice(instructions, criteriaFor(pool)) };
  if (goalReached === undefined) questions.goal_reached = goalQuestion;
  const res = tally(await ts.systemOne({ state, questions }));

  const next = asChoice(res.answers.next);
  goalReached ??= asNoul(res.answers.goal_reached);
  const candidates: Candidate[] = ranked(next.probabilities, 5).map(([ref, probability]) => ({
    ref,
    probability: round(probability),
    description: describeOption(byRef.get(ref)!),
  }));

  if (next.choice !== NONE && next.confidence < verifyBelow) {
    const checked = candidates.slice(0, VERIFY_TOP);
    const checks: Record<string, Question> = {};
    checked.forEach((c, i) => {
      checks[`fit_${i}`] = noul(
        {
          question: "Does this action make progress toward the goal from the current page?",
          goal,
          action: actionText(byRef.get(c.ref)!.el, c.description, typeText),
        },
        {
          true: "It leads toward what the goal asks for, directly or through a relevant menu, search or section",
          false: "It leads somewhere unrelated, or does not help reach the goal",
        },
      );
    });
    const verification = tally(await ts.systemOne({ state, questions: checks }));
    checked.forEach((c, i) => (c.fit = round(asNoul(verification.answers[`fit_${i}`]))));
  }
  goalReached = await withArrival(goalReached);

  return {
    choice: next.choice === NONE ? null : next.choice,
    confidence: next.confidence,
    goalReached,
    candidates,
    ...usage,
  };
}

/**
 * Choisit l'option d'une liste déroulante : un Choice sur un ensemble fermé, le cas d'usage type de Jev.
 * `option` vaut null si Jev estime qu'aucune option ne convient.
 */
export async function chooseOption(goal: string, snap: Snapshot, el: PageElement) {
  const labels = el.options ?? [];
  const criteria: ChoiceCriteria = {};
  labels.forEach((label, i) => (criteria[`option_${i}`] = label || "(empty)"));
  criteria[NONE] = "None of these options helps to reach the goal";
  const res = await getClient().systemOne({
    state: { goal, page: { url: snap.url, title: snap.title }, dropdown: describe(el), page_text_start: snap.text },
    questions: {
      option: choice({ question: "Which option of the dropdown should be selected to make progress toward the goal?", goal }, criteria),
    },
  });
  const answer = res.answers.option;
  const option = answer.choice === NONE ? null : labels[Number(answer.choice.slice("option_".length))];
  return { option, confidence: answer.confidence, calls: 1, inputTokens: res.usage.input_tokens };
}

export const round = (x: number): number => Math.round(x * 1000) / 1000;
