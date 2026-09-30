// Content script : liste les éléments interactifs de la page et exécute les actions demandées.
// Injecté à la demande par background.js, d'où la garde contre une double injection.
(() => {
  if (window.__jevBridgeLoaded) return;
  window.__jevBridgeLoaded = true;

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]",
    "[role=menuitemradio]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=option]",
    "[role=combobox]", "[role=textbox]", "[role=searchbox]", "[role=treeitem]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]",
  ].join(",");

  const ZONES = [
    "nav", "header", "footer", "main", "aside", "form", "dialog",
    "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=main]", "[role=complementary]",
    "[role=search]", "[role=dialog]", "[role=menu]", "[role=tablist]",
  ].join(",");

  // Longueur des libellés d'options envoyés dans le snapshot, et donc acceptés par selectOption.
  const OPTION_LABEL_MAX = 40;
  // Nombre d'options listées dans le snapshot ; select cherche quand même dans toute la liste.
  const OPTIONS_MAX = 20;
  // Délai laissé à une liste ARIA pour s'ouvrir ou se fermer.
  const LISTBOX_WAIT_MS = 3000;

  // Avant de lire la page, le script de fond attend qu'elle ait fini de s'afficher : il sonde pageState, qui
  // repère les indicateurs de chargement. Texte entier d'un indicateur de chargement : « Chargement en cours », « Loading… », « Veuillez patienter ».
  // « Loading » seul, sans points de suspension, est trop souvent un mot ordinaire (titre, nom d'attribut).
  const LOADING_TEXT =
    /^(?:(?:chargement|loading)\b.{0,30}(?:…|\.{3})|chargement en cours\b.{0,40}|(?:veuillez |merci de )?patient(?:ez|er)\b.{0,40}|please wait\b.{0,40})$/i;
  // Indicateurs sans texte : zone marquée occupée, barre de progression sans valeur (qui tourne en boucle).
  const BUSY = "[aria-busy=true], progress:not([value]), [role=progressbar]:not([aria-valuenow])";

  // Dernier ajout ou retrait d'éléments dans la page. Le script est injecté à la demande : une page qu'on lit pour
  // la première fois paraît donc tout juste modifiée.
  let lastChange = performance.now();
  new MutationObserver(() => (lastChange = performance.now())).observe(document, { childList: true, subtree: true });
  // Indicateurs restés visibles tout un délai d'attente (texte fixe pris pour un indicateur, chargement sans fin) :
  // on ne les attend plus, mais on les signale encore.
  const stuck = new WeakSet();

  // ref -> élément, remis à zéro à chaque snapshot : les refs ne valent que pour le dernier snapshot.
  let refs = new Map();
  // section/article -> son titre, recalculé à chaque snapshot : les éléments d'une section le partagent.
  let headings = new Map();

  const clean = (s, max = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, max);
  const formOf = (el) => el.form || el.closest("form");
  const pageText = () => (document.body ? document.body.innerText : "");
  // Dans un onglet en arrière-plan, Firefox espace les timers de la page d'une seconde : le script de fond, dont les
  // timers ne sont pas ralentis, compte alors le temps à notre place.
  const sleep = (ms) => (document.hidden ? browser.runtime.sendMessage({ sleep: ms }) : new Promise((resolve) => setTimeout(resolve, ms)));
  const isTextInput = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  // Liste déroulante dessinée par la page (Angular Material, React Select...) plutôt qu'un <select> natif.
  const isAriaCombobox = (el) => el.getAttribute("role") === "combobox" && el.tagName !== "SELECT";
  const isOpen = (el) => el.getAttribute("aria-expanded") === "true";

  // Rappelle check jusqu'à ce qu'il renvoie une valeur, ou null après timeoutMs.
  async function waitFor(check, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(50);
    }
  }

  // Éléments interactifs et cadres (iframe, frame) de root et de ses shadow roots.
  function collect(root, out, frames) {
    for (const el of root.querySelectorAll(INTERACTIVE)) out.add(el);
    for (const host of root.querySelectorAll("*")) {
      if (host.tagName === "IFRAME" || host.tagName === "FRAME") frames.push(host);
      // openOrClosedShadowRoot est propre à Firefox et visible uniquement des extensions.
      const shadow = host.openOrClosedShadowRoot || host.shadowRoot;
      if (shadow) collect(shadow, out, frames);
    }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return !el.closest("[aria-hidden=true], [inert]");
  }

  const tagOf = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : "");

  // Indicateur de chargement visible ({ node, reason }), ou null. skipStuck : ignorer ceux qu'on n'attend plus.
  function busy(skipStuck) {
    const found = (node, reason) => (skipStuck && stuck.has(node) ? null : { node, reason });
    let hit;
    if (document.readyState === "loading" && (hit = found(document, "document en cours de chargement"))) return hit;
    for (const el of document.querySelectorAll(BUSY)) {
      if (isVisible(el) && (hit = found(el, `${tagOf(el)} ${el.hasAttribute("aria-busy") ? "aria-busy" : "progression"}`))) return hit;
    }
    const body = document.body;
    // Filtre rapide avant de parcourir les nœuds texte un par un.
    if (!body || !/chargement|loading|patient|please wait/i.test(body.textContent)) return null;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      const parent = node.parentElement;
      if (text.length >= 60 || !LOADING_TEXT.test(text) || !parent || parent.closest("code, pre, kbd, samp")) continue;
      if (isVisible(parent) && (hit = found(node, `texte « ${text} »`))) return hit;
    }
    return null;
  }

  // Sondé par le script de fond jusqu'à ce que la page ait fini de s'afficher : c'est lui qui attend, car ses
  // timers ne sont pas ralentis dans un onglet en arrière-plan. timedOut : délai écoulé, l'indicateur encore
  // visible ne sera plus attendu.
  function pageState({ timedOut }) {
    const hit = busy(true);
    if (timedOut && hit) stuck.add(hit.node);
    return { busy: Boolean(hit), idleMs: performance.now() - lastChange };
  }

  // Indicateur de chargement encore visible, pour le signaler dans le résultat, ou "".
  function loadingReason() {
    const hit = busy(false);
    return hit ? hit.reason : "";
  }

  // Cadre d'une fenêtre modale : un dialogue, ou un calque fixe qui couvre une bonne part de l'écran (un widget de
  // discussion, fixe lui aussi, reste petit).
  function isOnTop(frame) {
    if (frame.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]")) return true;
    const r = frame.getBoundingClientRect();
    if (r.width * r.height < 0.2 * innerWidth * innerHeight) return false;
    for (let node = frame; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === "fixed") return true;
    }
    return false;
  }

  // Nœud du document principal qui porte node : node lui-même, ou l'hôte de son shadow root le plus externe.
  // compareDocumentPosition ne sait pas ordonner deux nœuds de shadow trees différents.
  function anchorOf(node) {
    for (let root = node.getRootNode(); root instanceof ShadowRoot; root = node.getRootNode()) node = root.host;
    return node;
  }

  // Cadres visibles, que le script de fond explore à leur tour. index : nombre d'éléments de nodes qui les
  // précèdent, pour insérer leurs éléments à leur place.
  function framesOf(frameEls, nodes) {
    const out = [];
    for (const frame of frameEls) {
      if (!isVisible(frame)) continue;
      const frameId = browser.runtime.getFrameId(frame);
      if (frameId < 0) continue;
      const r = frame.getBoundingClientRect();
      let host = "";
      try {
        host = new URL(frame.src).host;
      } catch {}
      out.push({
        frameId,
        name: clean(frame.title || frame.getAttribute("aria-label") || frame.name || host || "iframe", 40),
        index: nodes.filter((n) => anchorOf(n).compareDocumentPosition(anchorOf(frame)) & Node.DOCUMENT_POSITION_FOLLOWING).length,
        inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
        onTop: isOnTop(frame),
      });
    }
    return out;
  }

  function textOfId(id) {
    const node = document.getElementById(id);
    return node ? node.innerText || node.textContent : "";
  }

  function accessibleName(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = clean(labelledBy.split(/\s+/).map(textOfId).join(" "));
      if (t) return t;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) {
      const v = clean(el.value);
      if (v) return v;
    }
    const text = clean(el.innerText);
    if (text) return text;
    const img = el.querySelector("img[alt], svg title");
    if (img) {
      const t = clean(img.getAttribute("alt") || img.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name"));
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "file") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "button";
  }

  // Libellés d'un bouton relié à un champ fichier voisin : sans eux, on ne le marque pas (le bouton « Envoyer » du
  // formulaire est souvent tout aussi proche du champ).
  const UPLOAD_LABEL = /\b(cv|resume|curriculum)\b|upload|import|télécharg|dépos|joindre|pièce jointe|fichier|file|attach|parcourir|browse/i;
  // Recalculé à chaque snapshot : la plupart des pages n'ont aucun champ fichier, et la recherche du champ voisin
  // est alors évitée.
  let hasFileInput = false;

  const isFileInput = (el) => el instanceof HTMLInputElement && el.type === "file";

  // Champ fichier derrière un élément : lui-même, le champ de son <label>, ou un champ (souvent caché) qu'il contient.
  function fileInputOf(el) {
    if (isFileInput(el)) return el;
    const label = el.closest("label");
    if (label && label.control && isFileInput(label.control)) return label.control;
    return el.querySelector("input[type=file]");
  }

  // Sinon, le seul champ fichier des conteneurs proches : un bouton « Importer » est souvent voisin d'un champ caché.
  function nearbyFileInput(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const inputs = node.querySelectorAll("input[type=file]");
      if (inputs.length === 1) return inputs[0];
      if (inputs.length > 1) return null;
    }
    return null;
  }

  function zoneOf(el) {
    const zone = el.parentElement && el.parentElement.closest(ZONES);
    if (!zone) return undefined;
    const kind = zone.getAttribute("role") || zone.tagName.toLowerCase();
    const label = clean(zone.getAttribute("aria-label"), 30);
    return label ? `${kind} "${label}"` : kind;
  }

  function sectionOf(el) {
    const section = el.closest("section, article");
    if (!section) return undefined;
    if (!headings.has(section)) {
      const node = section.querySelector("h1, h2, h3, h4");
      headings.set(section, node && { node, text: clean(node.innerText, 50) || undefined });
    }
    const heading = headings.get(section);
    return heading && !heading.node.contains(el) ? heading.text : undefined;
  }

  function shortHref(el) {
    try {
      const url = new URL(el.href);
      if (url.protocol === "javascript:") return undefined;
      // L'ancre compte : sans elle, les liens d'une table des matières sembleraient tous identiques.
      const path = url.pathname + url.search + url.hash;
      return clean(url.origin === location.origin ? path : url.host + path, 70);
    } catch {
      return undefined;
    }
  }

  // Champ où Entrée lance une recherche. Ailleurs (connexion, formulaire), Entrée enverrait un formulaire incomplet.
  function isSearchField(el) {
    if (el.type === "search" || el.getAttribute("role") === "searchbox") return true;
    if (el.closest("[role=search], search")) return true;
    const form = formOf(el);
    const hints = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, form && form.getAttribute("action")];
    return /search|recherch|query|chercher|\bq\b/i.test(hints.filter(Boolean).join(" "));
  }

  function describeElement(el, ref) {
    const r = el.getBoundingClientRect();
    const item = {
      ref,
      role: roleOf(el),
      name: accessibleName(el),
      inViewport: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    };
    if (el.tagName === "A") {
      item.href = shortHref(el);
      item.url = el.href;
    }
    if (el.tagName === "INPUT" && el.type) item.type = el.type;
    if (el.tagName === "INPUT" && isSearchField(el)) item.search = true;
    if (el.placeholder) item.placeholder = clean(el.placeholder, 50);
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value && !["button", "submit", "reset", "password", "checkbox", "radio"].includes(el.type)) {
      item.value = clean(el.value, 40);
    }
    if (el.tagName === "SELECT") {
      item.value = clean(el.selectedOptions[0] && el.selectedOptions[0].text, 40);
      item.options = [...el.options].slice(0, OPTIONS_MAX).map((o) => clean(o.text, OPTION_LABEL_MAX));
    }
    if (isAriaCombobox(el)) {
      // Hors champ texte, la valeur choisie est le texte affiché dans la liste fermée.
      if (!isTextInput(el)) {
        const shown = clean(el.innerText, 40);
        if (shown && shown !== item.name) item.value = shown;
      }
      // Les options d'une liste ARIA n'existent souvent qu'une fois la liste ouverte.
      const listbox = isOpen(el) && listboxOf(el);
      if (listbox) item.options = optionsOf(listbox).slice(0, OPTIONS_MAX).map((o) => optionLabel(o, OPTION_LABEL_MAX));
    }
    if (fileInputOf(el) || (UPLOAD_LABEL.test(item.name) && hasFileInput && nearbyFileInput(el))) item.upload = true;
    if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
    else if (el.hasAttribute("aria-checked")) item.checked = el.getAttribute("aria-checked") === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    // Dit à Jev qu'un bouton de navigation déplie un menu plutôt que d'ouvrir une page.
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") item.expanded = expanded === "true";
    else if (el.tagName === "SUMMARY" && el.parentElement && el.parentElement.tagName === "DETAILS") item.expanded = el.parentElement.open;
    const popup = el.getAttribute("aria-haspopup");
    if (popup && popup !== "false") item.popup = popup === "true" ? "menu" : popup;
    const zone = zoneOf(el);
    if (zone) item.zone = zone;
    const section = sectionOf(el);
    if (section) item.section = section;
    return item;
  }

  // Les refs sont propres à ce cadre : le script de fond les renumérote quand la page contient des iframes.
  function snapshot({ limit = 1000 }) {
    refs = new Map();
    headings = new Map();
    hasFileInput = document.querySelector("input[type=file]") !== null;
    const found = new Set();
    const frameEls = [];
    collect(document, found, frameEls);
    const elements = [];
    const nodes = [];
    for (const el of found) {
      if (elements.length >= limit) break;
      if (!isVisible(el)) continue;
      // Un élément imbriqué dans un lien ou un bouton ferait doublon avec son parent.
      if (el.parentElement && el.parentElement.closest("a[href], button")) continue;
      const ref = `e${elements.length + 1}`;
      refs.set(ref, el);
      nodes.push(el);
      elements.push(describeElement(el, ref));
    }
    return {
      url: location.href,
      title: document.title,
      elements,
      total: found.size,
      truncated: elements.length >= limit,
      text: clean(pageText(), 2000),
      frames: framesOf(frameEls, nodes),
      loading: loadingReason(),
    };
  }

  function getElement(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Élément ${ref} introuvable : la page a changé, il faut refaire un snapshot`);
    }
    return el;
  }

  function click(el) {
    // browse_goal suit un seul onglet : un lien prévu pour un nouvel onglet s'ouvre dans celui-ci. Un lien qui vise
    // la page entière depuis une iframe (_top, _parent) ou une iframe nommée garde sa cible.
    const link = el.closest("a[href]");
    let target = link && link.getAttribute("target");
    if (target && (/^_(self|top|parent)$/i.test(target) || document.querySelector(`iframe[name="${CSS.escape(target)}"], frame[name="${CSS.escape(target)}"]`))) {
      target = null;
    }
    if (target) link.setAttribute("target", "_self");
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    // click() déclenche l'événement click et l'action par défaut (navigation, submit, case à cocher).
    el.click();
    // La navigation est décidée pendant click() : on peut remettre la cible d'origine.
    if (target) link.setAttribute("target", target);
  }

  // Saisit text dans un champ. Renvoie un avertissement si le texte n'apparaît pas ensuite dans le champ.
  async function setValue(el, text) {
    // Vérifié avant tout focus : écrire dans une liste déroulante dessinée par la page la laisse dans un état
    // incohérent (liste vide à la réouverture).
    if (!isTextInput(el) && !el.isContentEditable) {
      throw new Error(
        isAriaCombobox(el) || el.tagName === "SELECT"
          ? "C'est une liste déroulante : utiliser l'action select avec le libellé de l'option"
          : "Cet élément n'est pas un champ de saisie",
      );
    }
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) return setEditableText(el, text);
    // Setter natif : les frameworks type React ne voient pas une affectation directe à value.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return undefined;
  }

  // Zone contenteditable. Les éditeurs riches (CKEditor 5, ProseMirror...) ignorent execCommand mais traitent un
  // collage : on colle d'abord, et execCommand ne sert que si la page n'a pas pris le collage en charge.
  async function setEditableText(el, text) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Les éditeurs suivent la sélection via selectionchange, un événement asynchrone.
    await sleep(50);
    // Objets de la page : les objets du content script ne lui sont pas lisibles (comme pour upload).
    const page = window.wrappedJSObject;
    const data = new page.DataTransfer();
    data.setData("text/plain", text);
    const init = cloneInto({ bubbles: true, cancelable: true, composed: true }, window);
    init.clipboardData = data;
    const pasted = !el.dispatchEvent(new page.ClipboardEvent("paste", init));
    if (!pasted) document.execCommand("insertText", false, text);
    await sleep(50);
    const firstLine = clean(text.split("\n")[0], 30);
    return clean(el.innerText, 100000).includes(firstLine)
      ? undefined
      : "Le texte n'apparaît pas dans l'éditeur : le vérifier, ou demander à l'utilisateur de le saisir";
  }

  function pressEnter(el) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    // Un Enter synthétique ne soumet pas le formulaire tout seul, sauf si la page l'a déjà géré.
    const form = formOf(el);
    if (notHandled && form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    }
  }

  function selectOption(el, text) {
    const wanted = text.toLowerCase();
    // Les libellés du snapshot sont tronqués : on accepte aussi cette forme.
    const option = [...el.options].find(
      (o) => o.value === text || clean(o.text).toLowerCase() === wanted || clean(o.text, OPTION_LABEL_MAX).toLowerCase() === wanted,
    );
    if (!option) throw new Error(`Option "${text}" absente de la liste`);
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return clean(option.text);
  }

  const hasBox = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };

  // Liste d'une combobox ARIA : celle que désigne aria-controls ou aria-owns, sinon la dernière liste affichée
  // (Angular Material la place dans un calque en fin de page). La seconde voie ne vaut que si la combobox est ouverte.
  function listboxOf(el) {
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (node && hasBox(node)) return node;
      }
    }
    if (!isOpen(el)) return null;
    const shown = [...document.querySelectorAll("[role=listbox]")].filter(hasBox);
    return shown[shown.length - 1] || null;
  }

  // Pas de filtre de visibilité : pendant l'animation d'ouverture, les options sont encore transparentes.
  const optionsOf = (listbox) => [...listbox.querySelectorAll("[role=option]")].filter(hasBox);
  const optionLabel = (o, max = 200) => clean(o.getAttribute("aria-label") || o.innerText || o.textContent, max);

  // Ferme une liste ARIA restée ouverte : une liste abandonnée ouverte empêche les autres de s'afficher.
  async function closeListbox(el) {
    if (!isOpen(el)) return;
    const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    const focused = document.activeElement && document.activeElement !== document.body ? document.activeElement : el;
    focused.dispatchEvent(new KeyboardEvent("keydown", init));
    focused.dispatchEvent(new KeyboardEvent("keyup", init));
    await waitFor(() => !isOpen(el), LISTBOX_WAIT_MS);
  }

  // Option voulue : libellé exact (entier ou tronqué comme dans le snapshot), sinon la seule option qui commence
  // par le texte, sinon la seule qui le contient.
  function matchOption(options, text) {
    const wanted = clean(text).toLowerCase();
    const labels = options.map((o) => optionLabel(o).toLowerCase());
    const exact = options.find((o, i) => labels[i] === wanted || labels[i].slice(0, OPTION_LABEL_MAX) === wanted);
    if (exact) return exact;
    for (const test of [(l) => l.startsWith(wanted), (l) => l.includes(wanted)]) {
      const found = options.filter((o, i) => test(labels[i]));
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        throw new Error(`"${text}" correspond à plusieurs options : ${found.slice(0, 10).map((o) => optionLabel(o, 60)).join(" | ")}`);
      }
    }
    return null;
  }

  // Liste ARIA : l'ouvre (ou, pour un champ d'autocomplétion, tape le texte pour la filtrer), clique l'option,
  // puis vérifie que la liste s'est refermée.
  async function selectAriaOption(el, text) {
    if (isTextInput(el)) await setValue(el, text);
    else if (!isOpen(el)) click(el);
    const listbox = await waitFor(() => {
      const node = listboxOf(el);
      return node && optionsOf(node).length ? node : null;
    }, LISTBOX_WAIT_MS);
    if (!listbox) {
      await closeListbox(el);
      throw new Error("La liste ne s'est pas ouverte, ou ne propose aucune option");
    }
    const options = optionsOf(listbox);
    let option;
    try {
      option = matchOption(options, text);
    } catch (err) {
      await closeListbox(el);
      throw err;
    }
    if (!option) {
      await closeListbox(el);
      const labels = options.slice(0, 50).map((o) => optionLabel(o, 60));
      const more = options.length > labels.length ? ` (+${options.length - labels.length} autres)` : "";
      throw new Error(`Option "${text}" absente de la liste. Options : ${labels.join(" | ")}${more}`);
    }
    if (option.getAttribute("aria-disabled") === "true") {
      await closeListbox(el);
      throw new Error(`L'option "${optionLabel(option, 60)}" est désactivée`);
    }
    const selected = optionLabel(option);
    click(option);
    // Liste à choix multiples : elle reste ouverte après le clic, on la ferme nous-mêmes.
    if (!(await waitFor(() => !isOpen(el), 1000))) await closeListbox(el);
    return selected;
  }

  async function act({ ref, action, text, submit }) {
    const el = getElement(ref);
    const target = `${roleOf(el)} "${accessibleName(el)}"`;
    if (action === "click") {
      // Lien d'iframe qui vise la page entière : Firefox bloque cette navigation sans vrai clic de l'utilisateur.
      // Le script de fond ouvre alors l'adresse du lien dans l'onglet.
      const link = window !== window.top && el.closest("a[href]");
      const whole = link && (link.target === "_top" || (link.target === "_parent" && window.parent === window.top));
      if (whole && /^https?:/.test(link.href)) return { action, target, open: link.href };
      click(el);
    } else if (action === "type") {
      if (typeof text !== "string") throw new Error("Le paramètre text est obligatoire pour type");
      const warning = await setValue(el, text);
      if (submit) pressEnter(el);
      if (warning) return { action, target, warning };
    } else if (action === "select") {
      if (typeof text !== "string") throw new Error("Le paramètre text est obligatoire pour select");
      if (el.tagName === "SELECT") return { action, target, selected: selectOption(el, text) };
      if (!isAriaCombobox(el)) throw new Error(`${ref} n'est pas une liste déroulante`);
      return { action, target, selected: await selectAriaOption(el, text) };
    } else {
      throw new Error(`Action inconnue : ${action}`);
    }
    return { action, target };
  }

  // Dépose des fichiers ({ name, type, data en base64 }) dans le champ fichier de l'élément, ou, à défaut,
  // les glisse-dépose sur l'élément (zones de dépôt sans champ).
  function upload({ ref, files }) {
    const el = getElement(ref);
    const target = `${roleOf(el)} "${accessibleName(el)}"`;
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const names = files.map((f) => f.name);
    const input = fileInputOf(el) || nearbyFileInput(el);
    if (input) {
      if (files.length > 1 && !input.multiple) throw new Error(`${ref} n'accepte qu'un fichier`);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { action: "upload", target, files: names, via: "input", accept: input.accept || undefined };
    }
    el.scrollIntoView({ block: "center" });
    const page = window.wrappedJSObject;
    const pageDt = new page.DataTransfer();
    for (const file of dt.files) pageDt.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      const init = cloneInto({ bubbles: true, cancelable: true, composed: true }, window);
      init.dataTransfer = pageDt;
      el.dispatchEvent(new page.DragEvent(type, init));
    }
    return { action: "upload", target, files: names, via: "drop" };
  }

  function readText({ maxChars = 8000 }) {
    const frameEls = [];
    collect(document, new Set(), frameEls);
    const text = pageText().replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, maxChars);
    return { text, frames: framesOf(frameEls, []), loading: loadingReason() };
  }

  // Adresse absolue du lien ref, pour l'enregistrer sans l'ouvrir.
  function linkUrl({ ref }) {
    const link = getElement(ref).closest("a[href]");
    if (!link || !/^https?:/.test(link.href)) {
      throw new Error(`${ref} n'est pas un lien vers un fichier : cliquer dessus avec browser_act, puis enregistrer l'onglet avec browser_save sans ref`);
    }
    return link.href;
  }

  // Télécharge url comme le ferait la page (content.fetch : mêmes cookies, même origine). Contenu en base64.
  async function fetchFile({ url }) {
    const res = await window.content.fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    // Au-delà, le fichier ne passe pas par le WebSocket : le script de fond renverra l'erreur.
    if (blob.size > 50 * 1024 * 1024) throw new Error("Fichier trop gros");
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { url: res.url, type: blob.type, disposition: res.headers.get("content-disposition") || undefined, size: blob.size, data };
  }

  function scroll({ direction }) {
    window.scrollBy({ top: (direction === "up" ? -1 : 1) * innerHeight * 0.8, behavior: "instant" });
    return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight };
  }

  const handlers = {
    snapshot,
    act,
    upload,
    read_text: readText,
    scroll,
    link_url: linkUrl,
    fetch_file: fetchFile,
    page_state: pageState,
  };

  browser.runtime.onMessage.addListener(async (msg) => {
    try {
      const handler = handlers[msg.cmd];
      if (!handler) throw new Error(`Commande inconnue : ${msg.cmd}`);
      return { ok: true, result: await handler(msg.args || {}) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
})();
